import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { ObjectId } from 'mongodb';
import { createApp, SESSION_DURATION } from '../../src/app.js';
import { createTestDatabase } from '../helpers/test-db.js';
import { createClock } from '../helpers/clock.js';
import { registerAndLogin } from '../helpers/auth-agent.js';
import { publishedSurvey, submissionPayload, submit, writeSurvey } from '../helpers/submission.js';

const GATE_TIMEOUT = 8000;
const HTTP_TIMEOUT = 20000;

async function bounded(promise, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), GATE_TIMEOUT);
    })]);
  } finally { clearTimeout(timer); }
}

function transactionGate(size = 1) {
  let arrive, release;
  const ready = new Promise(resolve => { arrive = resolve; });
  const released = new Promise(resolve => { release = resolve; });
  const contexts = [];
  const attempts = [];
  return {
    contexts, attempts, release,
    wait: () => bounded(ready, '目标事务未到达闸门'),
    async enter(context) {
      assert.equal(context.session.inTransaction(), true);
      attempts.push(context.attempt);
      if (context.attempt !== 1) return;
      contexts.push(context);
      if (contexts.length === size) arrive();
      await bounded(released, '事务闸门未释放');
    },
  };
}

function failure(response, status, code) {
  assert.equal(response.status, status, JSON.stringify(response.body));
  assert.equal(response.body.error.code, code);
}

test('R5-Verify：X01—X09 删除与真实 MongoDB 事务竞争', { timeout: 240000 }, async t => {
  const resource = await createTestDatabase();
  const clock = createClock();
  const submissionHooks = [{}, {}];
  const deletionHooks = [{}, {}];
  const errors = [];
  const pending = new Set();
  const gates = new Set();
  const collections = ['surveys', 'submissions', 'surveyGuards'];
  const oid = survey => new ObjectId(survey.id);
  const filter = (name, survey) => name === 'submissions' ? { surveyId: oid(survey) } : { _id: oid(survey) };
  const raw = survey => resource.db.collection('surveys').findOne({ _id: oid(survey) });
  const guard = survey => resource.db.collection('surveyGuards').findOne({ _id: oid(survey) });
  const answers = survey => resource.db.collection('submissions').find({ surveyId: oid(survey) }).sort({ _id: 1 }).toArray();
  const resetHooks = () => {
    for (const hooks of [...submissionHooks, ...deletionHooks]) for (const key of Object.keys(hooks)) delete hooks[key];
  };
  function send(http) {
    const promise = http.timeout({ deadline: HTTP_TIMEOUT }).then(response => response);
    pending.add(promise);
    promise.then(() => pending.delete(promise), () => pending.delete(promise));
    return promise;
  }
  function gated(hooks, name, survey, gate = transactionGate()) {
    gates.add(gate);
    hooks[name] = context => {
      if (context.survey._id.toHexString() === survey.id) return gate.enter(context);
    };
    return gate;
  }
  async function run(name, body) {
    await t.test(name, { timeout: 35000 }, async () => {
      try { await body(); }
      finally {
        for (const gate of gates) gate.release();
        await Promise.allSettled([...pending]);
        resetHooks();
        gates.clear();
      }
    });
  }
  async function snapshot(survey) {
    return { survey: await raw(survey), guard: await guard(survey), answers: await answers(survey) };
  }
  async function absent(survey) {
    for (const name of collections) assert.equal(await resource.db.collection(name).countDocuments(filter(name, survey)), 0, name);
  }

  try {
    // Independent service objects/session stores share only MongoDB and the clock.
    const apps = [0, 1].map(index => createApp({ ...resource, clock,
      submissionHooks: submissionHooks[index], deletionHooks: deletionHooks[index],
      config: { sessionSecret: 'r5-deletion-shared-test-session-secret-longer-than32', cookieSecure: false },
      logger: { error: error => errors.push(error) },
    }));
    assert.notEqual(apps[0], apps[1]);
    t.diagnostic(`本套件独占测试库：${resource.db.databaseName}；两个独立 createApp`);
    const owner = await registerAndLogin(apps[0], '删除作者');
    const other = await registerAndLogin(apps[1], '另一作者');
    const filler = await registerAndLogin(apps[1], '删除填写者');
    const ownerAgent = request.agent(apps[1]);
    const csrf = (await ownerAgent.get('/api/auth/csrf').expect(200)).body.data.csrfToken;
    const login = await ownerAgent.post('/api/auth/login').set('X-CSRF-Token', csrf)
      .send({ username: owner.user.username, password: ' pass word ' }).expect(200);
    const remoteOwner = { agent: ownerAgent, user: owner.user, csrfToken: login.body.data.csrfToken };
    const multiple = { settings: { anonymityMode: 'optional', allowMultipleSubmissions: true } };
    const bodyFor = (survey, extra = {}) => ({ revision: survey.revision, expectedUserId: owner.user.id, confirmation: '删除', ...extra });
    const remove = (survey, identity = owner, body = bodyFor(survey)) => identity.agent.delete(`/api/surveys/${survey.id}`)
      .set('X-CSRF-Token', identity.csrfToken).send(body);
    const preview = (survey, identity = owner) => identity.agent.get(`/api/surveys/${survey.id}/deletion-preview`);
    const draft = async (identity = owner) => (await writeSurvey(identity, '', { settings: { anonymityMode: 'optional' } }).expect(201)).body.data;
    const close = async survey => (await writeSurvey(owner, `/${survey.id}/close`, { revision: (await raw(survey)).revision }).expect(200)).body.data;
    const save = (survey, body = submissionPayload(survey, filler)) => send(submit(filler, survey, body));

    await run('X01 草稿/关闭/恰好截止可删；开放拒绝，预览无副作用且不泄漏字段', async () => {
      const empty = await draft();
      const before = await snapshot(empty);
      const initial = await preview(empty).expect(200);
      assert.deepEqual(initial.body.data, { id: empty.id, title: '', revision: 1, totalSubmissions: 0, canDelete: true });
      assert.deepEqual(await snapshot(empty), before);
      assert.ok(before.guard.token instanceof ObjectId);
      assert.equal(before.guard.schemaVersion, 1);
      const deleted = await remove(empty).expect(204);
      assert.equal(deleted.text, '');
      await absent(empty);
      const open = await publishedSurvey(owner);
      assert.equal((await preview(open).expect(200)).body.data.canDelete, false);
      const openState = await snapshot(open);
      failure(await remove(open), 409, 'SURVEY_STILL_OPEN');
      assert.deepEqual(await snapshot(open), openState);
      const closed = await close(open);
      await remove(closed).expect(204);
      await absent(closed);
      const expired = await publishedSurvey(owner, { deadlineAt: new Date(clock.now() + 1).toISOString() });
      assert.equal((await preview(expired).expect(200)).body.data.canDelete, false);
      clock.advance(1);
      assert.equal((await preview(expired).expect(200)).body.data.canDelete, true);
      assert.equal((await raw(expired)).status, 'published');
      await remove(expired).expect(204);
      await absent(expired);
    });

    await run('X02 匿名/实名多份答卷全删，预览计每份；其他问卷、账号、会话保持原样', async () => {
      const unrelated = await publishedSurvey(other, multiple);
      assert.equal((await save(unrelated)).status, 201);
      const unrelatedState = await snapshot(unrelated);
      const survey = await publishedSurvey(owner, multiple);
      let previousToken = (await guard(survey)).token;
      for (const anonymous of [true, false, true]) {
        assert.equal((await save(survey, submissionPayload(survey, filler, { anonymous }))).status, 201);
        const token = (await guard(survey)).token;
        assert.ok(token instanceof ObjectId);
        assert.equal(token.equals(previousToken), false, '每次新增答卷必须真实改变guard token');
        previousToken = token;
      }
      const closed = await close(survey);
      assert.deepEqual((await preview(closed).expect(200)).body.data,
        { id: closed.id, title: closed.title, revision: closed.revision, totalSubmissions: 3, canDelete: true });
      const usersBefore = await resource.db.collection('users').find({}).sort({ _id: 1 }).toArray();
      const sessionsBefore = await resource.db.collection('sessions').find({}).sort({ _id: 1 }).toArray();
      await remove(closed).expect(204);
      await absent(closed);
      assert.deepEqual(await snapshot(unrelated), unrelatedState);
      assert.deepEqual(await resource.db.collection('users').find({}).sort({ _id: 1 }).toArray(), usersBefore);
      assert.deepEqual(await resource.db.collection('sessions').find({}).sort({ _id: 1 }).toArray(), sessionsBefore);
      await owner.agent.get('/api/auth/me').expect(200);
      await filler.agent.get('/api/auth/me').expect(200);
    });

    await run('X03 登录/所有权/CSRF/账号/版本/确认/输入均由HTTP拒绝且不删除', async () => {
      const survey = await draft();
      const before = await snapshot(survey);
      failure(await request(apps[0]).get(`/api/surveys/${survey.id}/deletion-preview`), 401, 'AUTH_REQUIRED');
      failure(await request(apps[0]).delete(`/api/surveys/${survey.id}`).send(bodyFor(survey)), 401, 'AUTH_REQUIRED');
      failure(await preview(survey, other), 404, 'NOT_FOUND');
      failure(await remove(survey, other, bodyFor(survey, { expectedUserId: other.user.id })), 404, 'NOT_FOUND');
      for (const id of ['invalid', new ObjectId().toHexString()]) {
        failure(await preview({ ...survey, id }), 404, 'NOT_FOUND');
        failure(await remove({ ...survey, id }), 404, 'NOT_FOUND');
      }
      failure(await owner.agent.delete(`/api/surveys/${survey.id}`).send(bodyFor(survey)), 403, 'CSRF_INVALID');
      failure(await remove(survey, { ...owner, csrfToken: '0'.repeat(64) }), 403, 'CSRF_INVALID');
      failure(await remove(survey, other), 409, 'ACCOUNT_CHANGED');
      failure(await remove(survey, owner, bodyFor(survey, { revision: survey.revision + 1 })), 409, 'REVISION_CONFLICT');
      for (const revision of [undefined, null, 0, -1, '1', 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        failure(await remove(survey, owner, bodyFor(survey, { revision })), 400, 'INVALID_REVISION');
      }
      for (const body of [[], { ...bodyFor(survey), ownerId: owner.user.id }, bodyFor(survey, { confirmation: null }),
        bodyFor(survey, { expectedUserId: null }), bodyFor(survey, { expectedUserId: 'invalid' }), bodyFor(survey, { expectedUserId: undefined })]) {
        failure(await remove(survey, owner, body), 400, 'INVALID_BODY');
      }
      for (const confirmation of [undefined, '', '确认', ' 删除', '删除 ', '删除\n']) {
        failure(await remove(survey, owner, bodyFor(survey, { confirmation })), 422, 'CONFIRMATION_REQUIRED');
      }
      failure(await preview(survey).query({ extra: '1' }), 400, 'INVALID_QUERY');
      failure(await remove(survey).query({ extra: '1' }), 400, 'INVALID_QUERY');
      assert.deepEqual(await snapshot(survey), before);
    });

    await run('X04 缺guard时首份/后续提交与删除均503，不upsert、不冻结、不部分清理；成功重放仍200', async () => {
      for (const seeded of [false, true]) {
        const survey = await publishedSurvey(owner, multiple);
        const successfulBody = submissionPayload(survey, filler);
        if (seeded) assert.equal((await save(survey, successfulBody)).status, 201);
        await resource.db.collection('surveyGuards').deleteOne({ _id: oid(survey) });
        const before = await snapshot(survey);
        failure(await save(survey), 503, 'TEMPORARY_UNAVAILABLE');
        assert.deepEqual(await snapshot(survey), before);
        if (seeded) assert.equal((await save(survey, successfulBody)).status, 200);
        const closed = await close(survey);
        const closedState = await snapshot(survey);
        failure(await remove(closed), 503, 'TEMPORARY_UNAVAILABLE');
        assert.deepEqual(await snapshot(survey), closedState);
        assert.equal(await guard(survey), null);
      }
    });

    for (const seeded of [false, true]) {
      await run(`X05 删除先提交：${seeded ? '后续' : '首份'}已受理答卷停在guard前，删后404且无孤立记录`, async () => {
        const survey = await publishedSurvey(owner, multiple);
        if (seeded) assert.equal((await save(survey)).status, 201);
        const gate = gated(submissionHooks[1], 'afterAccepted', survey);
        const payload = submissionPayload(survey, filler);
        const inFlight = save(survey, payload);
        await gate.wait();
        assert.equal(gate.contexts[0].survey.contentLocked, seeded);
        const closed = await close(survey);
        await remove(closed).expect(204);
        await absent(survey);
        gate.release();
        failure(await inFlight, 404, 'NOT_FOUND');
        failure(await save(survey, payload), 404, 'NOT_FOUND');
        await absent(survey);
      });
    }

    for (const seeded of [false, true]) {
      await run(`X06 提交先写guard：${seeded ? '后续关闭后删除重试含新答卷' : '首份到期后删除遇冻结版本冲突须重新确认'}`, async () => {
        const survey = await publishedSurvey(owner, { ...multiple, deadlineAt: new Date(clock.now() + 100).toISOString() });
        if (seeded) assert.equal((await save(survey)).status, 201);
        const before = await snapshot(survey);
        const submissionGate = gated(submissionHooks[1], 'afterGuard', survey);
        const inFlight = save(survey);
        await submissionGate.wait();
        const context = submissionGate.contexts[0];
        const inside = await resource.db.collection('surveyGuards').findOne({ _id: oid(survey) }, { session: context.session });
        assert.equal(inside.token.equals(before.guard.token), false);
        assert.deepEqual(await guard(survey), before.guard, '未提交guard更改不可外部可见');
        let eligible;
        if (seeded) eligible = await close(survey);
        else { clock.advance(100); eligible = { ...survey, revision: before.survey.revision }; }
        const deletionGate = transactionGate();
        const countsRead = [];
        gates.add(deletionGate);
        deletionHooks[0].afterRead = async context => {
          if (context.survey._id.toHexString() !== survey.id) return;
          countsRead.push(await resource.db.collection('submissions').countDocuments(
            { surveyId: oid(survey) }, { session: context.session }));
          await deletionGate.enter(context);
        };
        const viewed = (await preview(eligible).expect(200)).body.data;
        assert.equal(viewed.totalSubmissions, seeded ? 1 : 0);
        const deleting = send(remove(eligible));
        await deletionGate.wait();
        // Delete has already read its snapshot while the other app owns guard.
        deletionGate.release();
        submissionGate.release();
        assert.equal((await inFlight).status, 201);
        const deleted = await deleting;
        if (seeded) {
          assert.equal(deleted.status, 204, JSON.stringify(deleted.body));
          assert.equal(countsRead[0], 1);
          assert.equal(countsRead.at(-1), 2, '重试快照必须包含先保存的后续答卷');
          assert.ok(deletionGate.attempts.some(attempt => attempt > 1), '必须经过真实事务冲突重试');
        } else {
          failure(deleted, 409, 'REVISION_CONFLICT');
          assert.equal((await answers(survey)).length, 1);
          assert.equal((await raw(survey)).contentLocked, true);
          const refreshed = (await preview(survey).expect(200)).body.data;
          assert.equal(refreshed.revision, eligible.revision + 1);
          assert.equal(refreshed.totalSubmissions, 1);
          await remove(refreshed).expect(204);
        }
        await absent(survey);
      });
    }

    for (const hookName of ['afterAccepted', 'afterGuard']) {
      for (const action of ['close', 'expire']) {
        await run(`X06/D6 无删除：后续提交在${hookName}受理后${action}仍可保存`, async () => {
          const deadline = clock.now() + 10;
          const survey = await publishedSurvey(owner, { ...multiple, deadlineAt: new Date(deadline).toISOString() });
          assert.equal((await save(survey)).status, 201);
          const before = await raw(survey);
          const gate = gated(submissionHooks[1], hookName, survey);
          const inFlight = save(survey);
          await gate.wait();
          if (action === 'close') await close(survey);
          else clock.advance(10);
          const acceptedState = await raw(survey);
          gate.release();
          assert.equal((await inFlight).status, 201);
          assert.equal((await answers(survey)).length, 2);
          assert.deepEqual(await raw(survey), acceptedState);
          assert.equal(acceptedState.firstSubmittedAt.getTime(), before.firstSubmittedAt.getTime());
          failure(await save(survey), 409, 'SURVEY_NOT_OPEN');
        });
      }
    }

    for (const hookName of ['afterGuard', 'afterDeleteAnswers', 'beforeCommit']) {
      await run(`X07 ${hookName}注入失败：真实事务内阶段可见、外部不可见，全部原样回滚`, async () => {
        const survey = await publishedSurvey(owner, multiple);
        for (const anonymous of [true, false]) assert.equal((await save(survey, submissionPayload(survey, filler, { anonymous }))).status, 201);
        const closed = await close(survey);
        const before = await snapshot(survey);
        let faults = 0;
        deletionHooks[0][hookName] = async context => {
          if (context.survey._id.toHexString() !== survey.id || context.attempt !== 1) return;
          assert.equal(context.session.inTransaction(), true);
          assert.equal(await resource.db.collection('surveyGuards').countDocuments({ _id: oid(survey) }, { session: context.session }), 0);
          assert.equal(await resource.db.collection('submissions').countDocuments({ surveyId: oid(survey) }, { session: context.session }), hookName === 'afterGuard' ? 2 : 0);
          assert.equal(await resource.db.collection('surveys').countDocuments({ _id: oid(survey) }, { session: context.session }), hookName === 'beforeCommit' ? 0 : 1);
          assert.deepEqual(await snapshot(survey), before);
          faults++;
          throw new Error(`R5 ${hookName} 事务回滚故障`);
        };
        failure(await send(remove(closed)), 503, 'TEMPORARY_UNAVAILABLE');
        assert.equal(faults, 1);
        assert.deepEqual(await snapshot(survey), before);
        delete deletionHooks[0][hookName];
        await remove(closed).expect(204);
        await absent(survey);
      });
    }

    for (const action of ['reopen', 'extend', 'edit']) {
      await run(`X07 删除已读旧资格后另一app执行${action}：真实冲突重读版本，不删除新状态`, async () => {
        let survey = await publishedSurvey(owner, multiple);
        if (action === 'extend') {
          survey = (await writeSurvey(owner, `/${survey.id}`, { revision: survey.revision, deadlineAt: new Date(clock.now()).toISOString() }, 'patch').expect(200)).body.data;
        } else survey = await close(survey);
        const gate = gated(deletionHooks[0], 'afterRead', survey);
        const deleting = send(remove(survey));
        await gate.wait();
        const updated = action === 'reopen'
          ? await writeSurvey(remoteOwner, `/${survey.id}/reopen`, { revision: survey.revision }).expect(200)
          : await writeSurvey(remoteOwner, `/${survey.id}`, { revision: survey.revision,
            ...(action === 'extend' ? { deadlineAt: new Date(clock.now() + 1000).toISOString() } : { title: '删除期间修改标题' }) }, 'patch').expect(200);
        const afterUpdate = await snapshot(survey);
        gate.release();
        failure(await deleting, 409, 'REVISION_CONFLICT');
        assert.deepEqual(await snapshot(survey), afterUpdate);
        failure(await remove(survey), 409, 'REVISION_CONFLICT');
        const refreshed = (await preview(survey).expect(200)).body.data;
        assert.equal(refreshed.revision, updated.body.data.revision);
        assert.equal(refreshed.canDelete, action === 'edit');
        if (action !== 'edit') failure(await remove(refreshed), 409, 'SURVEY_STILL_OPEN');
      });
    }

    await run('X07 两个app同快照并发删除：仅一204，另一404；重复删除仍404', async () => {
      const survey = await draft();
      const gate = transactionGate(2);
      gated(deletionHooks[0], 'afterRead', survey, gate);
      gated(deletionHooks[1], 'afterRead', survey, gate);
      const deleting = [send(remove(survey)), send(remove(survey, remoteOwner))];
      await gate.wait();
      assert.notEqual(gate.contexts[0].session, gate.contexts[1].session);
      gate.release();
      const results = await Promise.all(deleting);
      assert.deepEqual(results.map(response => response.status).sort(), [204, 404]);
      failure(results.find(response => response.status === 404), 404, 'NOT_FOUND');
      failure(await remove(survey), 404, 'NOT_FOUND');
      await absent(survey);
    });

    await run('X08 删除后旧链接API/管理/统计/明细/原requestId统一404，不重建；未删关闭到期仍200重放', async () => {
      const survey = await publishedSurvey(owner, { ...multiple, deadlineAt: new Date(clock.now() + 10).toISOString() });
      const payload = submissionPayload(survey, filler);
      const saved = await save(survey, payload);
      assert.equal(saved.status, 201);
      const closed = await close(survey);
      clock.advance(10);
      const replayed = await save(survey, payload);
      assert.equal(replayed.status, 200);
      assert.equal(replayed.body.data.submissionId, saved.body.data.submissionId);
      await remove(closed).expect(204);
      const fill = await filler.agent.get(`/api/fill/${survey.slug}`);
      failure(fill, 404, 'NOT_FOUND');
      assert.equal(fill.body.error.message, '问卷不存在或已删除');
      for (const body of [payload, submissionPayload(survey, filler)]) {
        const response = await save(survey, body);
        failure(response, 404, 'NOT_FOUND');
        assert.equal(response.body.error.message, '问卷不存在或已删除');
      }
      for (const suffix of ['', '/deletion-preview', '/statistics', '/questions/q/statistics', '/questions/q/answers', '/submissions', `/submissions/${saved.body.data.submissionId}`]) {
        failure(await owner.agent.get(`/api/surveys/${survey.id}${suffix}`), 404, 'NOT_FOUND');
      }
      await absent(survey);
    });

    await run('X09 删除已提交后丢响应：503并非回滚，原账号重试404，不能恢复旧requestId', async () => {
      const survey = await publishedSurvey(owner, multiple);
      const payload = submissionPayload(survey, filler);
      assert.equal((await save(survey, payload)).status, 201);
      const closed = await close(survey);
      let faults = 0;
      deletionHooks[0].afterCommit = async ({ surveyId }) => {
        if (surveyId !== survey.id) return;
        await absent(survey);
        faults++;
        throw new Error('R5 删除真实提交后丢失成功响应');
      };
      failure(await send(remove(closed)), 503, 'TEMPORARY_UNAVAILABLE');
      assert.equal(faults, 1);
      await absent(survey);
      await owner.agent.get('/api/auth/me').expect(200);
      failure(await remove(closed, remoteOwner), 404, 'NOT_FOUND');
      failure(await preview(survey, remoteOwner), 404, 'NOT_FOUND');
      failure(await save(survey, payload), 404, 'NOT_FOUND');
      assert.equal(faults, 1);
      await absent(survey);
    });

    await run('X09 提交响应未知后整卷删除：原requestId终止于404，无孤立答卷', async () => {
      const survey = await publishedSurvey(owner);
      const payload = submissionPayload(survey, filler);
      let calls = 0;
      submissionHooks[1].afterCommit = async ({ result }) => {
        const stored = await answers(survey);
        if (!stored.some(answer => answer._id.toHexString() === result.submissionId)) return;
        calls++;
        throw new Error('R5 答卷真实提交后响应未知');
      };
      failure(await save(survey, payload), 503, 'TEMPORARY_UNAVAILABLE');
      assert.equal(calls, 1);
      assert.equal((await answers(survey)).length, 1);
      const closed = await close(survey);
      await remove(closed).expect(204);
      failure(await save(survey, payload), 404, 'NOT_FOUND');
      assert.equal(calls, 1);
      await absent(survey);
    });

    await run('X09 删除503但目标仍在：账号变化/过期不能当成功，版本变化须重新确认', async () => {
      const survey = await draft();
      const gate = gated(deletionHooks[0], 'afterRead', survey);
      const deleting = send(remove(survey));
      await gate.wait();
      // Release with a nonretryable fault before the first destructive write.
      deletionHooks[0].afterGuard = context => {
        if (context.survey._id.toHexString() === survey.id && context.attempt === 1) throw new Error('R5 删除未提交故障');
      };
      gate.release();
      failure(await deleting, 503, 'TEMPORARY_UNAVAILABLE');
      resetHooks();
      const before = await snapshot(survey);
      failure(await remove(survey, other), 409, 'ACCOUNT_CHANGED');
      assert.deepEqual(await snapshot(survey), before);
      const changed = (await writeSurvey(remoteOwner, `/${survey.id}`, { revision: survey.revision, title: '待确认时已更新' }, 'patch').expect(200)).body.data;
      failure(await remove(survey), 409, 'REVISION_CONFLICT');
      const updated = await snapshot(survey);
      const current = (await preview(survey).expect(200)).body.data;
      assert.equal(current.revision, changed.revision);
      clock.advance(SESSION_DURATION);
      failure(await remove(current), 401, 'AUTH_REQUIRED');
      failure(await preview(survey), 401, 'AUTH_REQUIRED');
      assert.deepEqual(await snapshot(survey), updated);
    });

    assert.deepEqual(errors, [], '不得出现未处理的数据库或会话错误');
  } finally {
    for (const gate of gates) gate.release();
    await Promise.allSettled([...pending]);
    resetHooks();
    await resource.cleanup();
  }
});
