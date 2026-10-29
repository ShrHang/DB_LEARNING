import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { createApp } from '../../src/app.js';
import { createTestDatabase } from '../helpers/test-db.js';
import { createClock } from '../helpers/clock.js';
import { registerAndLogin } from '../helpers/auth-agent.js';
import { publishedSurvey, submissionPayload, submit, writeSurvey } from '../helpers/submission.js';

const GATE_TIMEOUT = 5000;
const HTTP_TIMEOUT = 15000;

async function bounded(promise, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), GATE_TIMEOUT); }),
    ]);
  } finally { clearTimeout(timer); }
}

// Both the test's arrival wait and the hook's release wait have deadlines.
// Only first attempts wait: a real driver retry must take a new snapshot.
function acceptedGate(size) {
  let markReady, release;
  const ready = new Promise(resolve => { markReady = resolve; });
  const released = new Promise(resolve => { release = resolve; });
  const contexts = [];
  return {
    contexts,
    release,
    wait: () => bounded(ready, 'afterAccepted 请求未全部到达闸门'),
    async enter(context) {
      assert.equal(context.session.inTransaction(), true);
      if (context.attempt !== 1) return;
      contexts.push(context);
      if (contexts.length === size) markReady();
      await bounded(released, 'afterAccepted 闸门未被释放');
    },
  };
}

function failure(response, code) {
  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.equal(response.body.error.code, code);
}

test('R3-concurrency：真实 MongoDB 事务、幂等与受理竞争', { timeout: 120000 }, async t => {
  const resource = await createTestDatabase();
  const clock = createClock();
  const submissionHooks = {};
  const errors = [];
  const pending = new Set();
  let app;

  function send(identity, survey, payload) {
    // Start Supertest's thenable immediately, retaining every request until done.
    const promise = submit(identity, survey, payload).timeout({ deadline: HTTP_TIMEOUT }).then(response => response);
    pending.add(promise);
    promise.then(() => pending.delete(promise), () => pending.delete(promise));
    return promise;
  }
  const raw = survey => resource.db.collection('surveys').findOne({ _id: new ObjectId(survey.id) });
  const documents = survey => resource.db.collection('submissions').find({ surveyId: new ObjectId(survey.id) }).toArray();
  const resetHooks = () => { for (const key of Object.keys(submissionHooks)) delete submissionHooks[key]; };
  async function run(name, body) {
    await t.test(name, { timeout: 25000 }, async () => {
      try { await body(); }
      finally {
        resetHooks();
        await Promise.allSettled([...pending]);
      }
    });
  }
  async function gated(survey, size, body) {
    const gate = acceptedGate(size);
    submissionHooks.afterAccepted = context => {
      if (context.survey._id.toHexString() === survey.id) return gate.enter(context);
    };
    try { return await body(gate); }
    finally {
      gate.release();
      // Drain requests before resetting hooks or dropping this suite's database.
      await Promise.allSettled([...pending]);
      resetHooks();
    }
  }
  async function assertFrozen(survey, expectedCount) {
    const stored = await documents(survey);
    const current = await raw(survey);
    assert.equal(stored.length, expectedCount);
    assert.equal(current.contentLocked, true);
    assert.equal(current.revision, survey.revision + 1);
    assert.equal(current.definitionRevision, survey.definitionRevision);
    assert.ok(stored.some(document => document.submittedAt.getTime() === current.firstSubmittedAt.getTime()));
    return stored;
  }

  try {
    app = createApp({
      ...resource, clock, submissionHooks,
      config: { sessionSecret: 'r3-concurrency-real-transactions-secret-32-plus', cookieSecure: false },
      logger: { error: error => errors.push(error) },
    });
    t.diagnostic(`本套件独占测试库：${resource.db.databaseName}`);
    const owner = await registerAndLogin(app, '并发作者');
    const fillers = [];
    for (let index = 0; index < 3; index++) fillers.push(await registerAndLogin(app, `并发填写${index}`));
    const filler = fillers[0];
    const multiple = { settings: { anonymityMode: 'optional', allowMultipleSubmissions: true } };

    await run('I08 单次问卷不同 requestId 并发：仅一份201，匿名切换仍共用次数', async () => {
      const survey = await publishedSurvey(owner);
      const bodies = Array.from({ length: 4 }, (_, index) => submissionPayload(survey, filler, { anonymous: index % 2 === 0 }));
      let responses;
      await gated(survey, bodies.length, async gate => {
        const requests = bodies.map(body => send(filler, survey, body));
        await gate.wait();
        gate.release();
        responses = await Promise.all(requests);
      });
      assert.equal(responses.filter(response => response.status === 201).length, 1);
      for (const response of responses.filter(response => response.status !== 201)) failure(response, 'ALREADY_SUBMITTED');
      const [document] = await assertFrozen(survey, 1);
      const winner = responses.findIndex(response => response.status === 201);
      assert.equal(document.requestId, bodies[winner].requestId);
      assert.equal(document.anonymous, bodies[winner].anonymous);
      assert.equal(document.singleOnly, true);
    });

    await run('I08 多次问卷不同 requestId 并发：每份均保存且只冻结一次', async () => {
      const survey = await publishedSurvey(owner, multiple);
      const bodies = Array.from({ length: 4 }, (_, index) => submissionPayload(survey, filler, { answers: [{ questionId: 'q', value: `并发答案${index}` }] }));
      await gated(survey, bodies.length, async gate => {
        const requests = bodies.map(body => send(filler, survey, body));
        await gate.wait();
        gate.release();
        for (const response of await Promise.all(requests)) assert.equal(response.status, 201, JSON.stringify(response.body));
      });
      const stored = await assertFrozen(survey, bodies.length);
      assert.deepEqual(stored.map(document => document.requestId).sort(), bodies.map(body => body.requestId).sort());
      assert.deepEqual(stored.map(document => document.answers[0].value).sort(), bodies.map(body => body.answers[0].value).sort());
      assert.ok(stored.every(document => document.singleOnly === false));
    });

    await run('I08 单次问卷多账号并发：相同 requestId 在各账号独立保存', async () => {
      const survey = await publishedSurvey(owner);
      const requestId = randomUUID();
      await gated(survey, fillers.length, async gate => {
        const requests = fillers.map(identity => send(identity, survey, submissionPayload(survey, identity, { requestId })));
        await gate.wait();
        gate.release();
        for (const response of await Promise.all(requests)) assert.equal(response.status, 201, JSON.stringify(response.body));
      });
      const stored = await assertFrozen(survey, fillers.length);
      assert.deepEqual(stored.map(document => document.respondentId.toHexString()).sort(), fillers.map(identity => identity.user.id).sort());
      assert.ok(stored.every(document => document.requestId === requestId));
    });

    await run('I09 单次/多次同 key 同 payload 并发：一201、其余200且ID相同', async () => {
      for (const allowMultipleSubmissions of [false, true]) {
        const survey = await publishedSurvey(owner, { settings: { anonymityMode: 'optional', allowMultipleSubmissions } });
        const body = submissionPayload(survey, filler);
        let responses;
        await gated(survey, 3, async gate => {
          const requests = Array.from({ length: 3 }, () => send(filler, survey, body));
          await gate.wait();
          gate.release();
          responses = await Promise.all(requests);
        });
        assert.deepEqual(responses.map(response => response.status).sort(), [200, 200, 201]);
        const original = responses.find(response => response.status === 201).body.data;
        for (const response of responses) {
          assert.deepEqual(response.body.data, { ...original, replayed: response.status === 200 });
        }
        const [document] = await assertFrozen(survey, 1);
        assert.equal(document._id.toHexString(), original.submissionId);
      }
    });

    await run('I09 单次/多次同 key 不同 payload 并发：仅一成功，其他为幂等冲突', async () => {
      for (const allowMultipleSubmissions of [false, true]) {
        const survey = await publishedSurvey(owner, { settings: { anonymityMode: 'optional', allowMultipleSubmissions } });
        const requestId = randomUUID();
        const bodies = Array.from({ length: 3 }, (_, index) => submissionPayload(survey, filler, { requestId, answers: [{ questionId: 'q', value: `不同内容${index}` }] }));
        let responses;
        await gated(survey, bodies.length, async gate => {
          const requests = bodies.map(body => send(filler, survey, body));
          await gate.wait();
          gate.release();
          responses = await Promise.all(requests);
        });
        assert.equal(responses.filter(response => response.status === 201).length, 1);
        for (const response of responses.filter(response => response.status !== 201)) failure(response, 'IDEMPOTENCY_CONFLICT');
        const [document] = await assertFrozen(survey, 1);
        assert.deepEqual(document.answers, bodies[responses.findIndex(response => response.status === 201)].answers);
      }
    });

    await run('I10 afterFreeze 故障回滚答卷/冻结/revision；移除故障原 key 可成功', async () => {
      const survey = await publishedSurvey(owner);
      const before = await raw(survey);
      const body = submissionPayload(survey, filler);
      let faults = 0;
      submissionHooks.afterFreeze = async ({ survey: accepted, session }) => {
        assert.equal(session.inTransaction(), true);
        const inside = await resource.db.collection('surveys').findOne({ _id: accepted._id }, { session });
        assert.equal(inside.contentLocked, true);
        assert.equal(inside.revision, before.revision + 1);
        assert.equal(inside.firstSubmittedAt.getTime(), clock.now());
        faults++;
        throw new Error('R3-concurrency：冻结后不可重试的注入故障');
      };
      const failed = await send(filler, survey, body);
      assert.equal(failed.status, 503);
      assert.equal(failed.body.error.code, 'TEMPORARY_UNAVAILABLE');
      assert.equal(faults, 1);
      assert.deepEqual(await documents(survey), []);
      assert.deepEqual(await raw(survey), before);
      delete submissionHooks.afterFreeze;
      assert.equal((await send(filler, survey, body)).status, 201);
      await assertFrozen(survey, 1);
    });

    await run('I09/I14 afterCommit 故障返回503但实际保存；关闭到期后原 key 仍重放200', async () => {
      const survey = await publishedSurvey(owner, { deadlineAt: new Date(clock.now() + 100).toISOString() });
      const body = submissionPayload(survey, filler);
      let committed;
      let commitHooks = 0;
      submissionHooks.afterCommit = async ({ result }) => {
        commitHooks++;
        committed = result;
        const [document] = await documents(survey);
        assert.equal(document._id.toHexString(), result.submissionId);
        throw new Error('R3-concurrency：提交后丢失成功响应');
      };
      const lost = await send(filler, survey, body);
      assert.equal(lost.status, 503);
      assert.equal(lost.body.error.code, 'TEMPORARY_UNAVAILABLE');
      assert.equal(commitHooks, 1);
      await assertFrozen(survey, 1);
      const replayed = await send(filler, survey, body);
      assert.equal(replayed.status, 200);
      assert.deepEqual(replayed.body.data, { ...committed, replayed: true });
      assert.equal(commitHooks, 1, '成功重放不得再次进入提交后故障钩子');
      delete submissionHooks.afterCommit;
      const current = await raw(survey);
      await writeSurvey(owner, `/${survey.id}/close`, { revision: current.revision }).expect(200);
      clock.advance(100);
      const closed = await raw(survey);
      const replayClosed = await send(filler, survey, body);
      assert.equal(replayClosed.status, 200);
      assert.deepEqual(replayClosed.body.data, { ...committed, replayed: true });
      failure(await send(filler, survey, { ...body, anonymous: false }), 'IDEMPOTENCY_CONFLICT');
      assert.equal((await documents(survey)).length, 1);
      assert.deepEqual(await raw(survey), closed);
      const extended = (await writeSurvey(owner, `/${survey.id}`, { revision: closed.revision, deadlineAt: null }, 'patch').expect(200)).body.data;
      await writeSurvey(owner, `/${survey.id}/reopen`, { revision: extended.revision }).expect(200);
      failure(await send(filler, survey, submissionPayload(survey, filler)), 'ALREADY_SUBMITTED');
      assert.equal((await documents(survey)).length, 1);
    });

    await run('I13 截止前1ms受理可在截止后完成；恰好截止的新请求拒绝', async () => {
      const deadline = clock.now() + 100;
      const survey = await publishedSurvey(owner, { ...multiple, deadlineAt: new Date(deadline).toISOString() });
      clock.advance(99);
      await gated(survey, 1, async gate => {
        const request = send(filler, survey, submissionPayload(survey, filler));
        await gate.wait();
        assert.equal(clock.now(), deadline - 1);
        clock.advance(1);
        gate.release();
        const response = await request;
        assert.equal(response.status, 201, JSON.stringify(response.body));
        assert.equal(response.body.data.submittedAt, new Date(deadline - 1).toISOString());
      });
      const before = await raw(survey);
      failure(await send(filler, survey, submissionPayload(survey, filler)), 'SURVEY_NOT_OPEN');
      await assertFrozen(survey, 1);
      assert.deepEqual(await raw(survey), before);
    });

    await run('I13 单纯到期延长可恢复；手动关闭后延长仍拒绝，须重开', async () => {
      const survey = await publishedSurvey(owner, { ...multiple, deadlineAt: new Date(clock.now()).toISOString() });
      const initial = await raw(survey);
      failure(await send(filler, survey, submissionPayload(survey, filler)), 'SURVEY_NOT_OPEN');
      assert.deepEqual(await raw(survey), initial);
      assert.deepEqual(await documents(survey), []);
      await writeSurvey(owner, `/${survey.id}`, { revision: initial.revision, deadlineAt: new Date(clock.now() + 1000).toISOString() }, 'patch').expect(200);
      assert.equal((await send(filler, survey, submissionPayload(survey, filler))).status, 201);
      let current = await raw(survey);
      await writeSurvey(owner, `/${survey.id}/close`, { revision: current.revision }).expect(200);
      current = await raw(survey);
      await writeSurvey(owner, `/${survey.id}`, { revision: current.revision, deadlineAt: new Date(clock.now() + 2000).toISOString() }, 'patch').expect(200);
      const closed = await raw(survey);
      failure(await send(filler, survey, submissionPayload(survey, filler)), 'SURVEY_NOT_OPEN');
      assert.deepEqual(await raw(survey), closed);
      assert.equal((await documents(survey)).length, 1);
      await writeSurvey(owner, `/${survey.id}/reopen`, { revision: closed.revision }).expect(200);
      assert.equal((await send(filler, survey, submissionPayload(survey, filler))).status, 201);
      assert.equal((await documents(survey)).length, 2);
    });

    await run('I13 已锁多次问卷受理后作者关闭：原请求成功、关闭后新请求拒绝', async () => {
      const survey = await publishedSurvey(owner, multiple);
      assert.equal((await send(filler, survey, submissionPayload(survey, filler))).status, 201);
      const locked = await raw(survey);
      let closed;
      await gated(survey, 1, async gate => {
        const request = send(filler, survey, submissionPayload(survey, filler));
        await gate.wait();
        assert.equal(gate.contexts[0].survey.contentLocked, true);
        await writeSurvey(owner, `/${survey.id}/close`, { revision: locked.revision }).expect(200);
        closed = await raw(survey);
        gate.release();
        const response = await request;
        assert.equal(response.status, 201, JSON.stringify(response.body));
      });
      failure(await send(filler, survey, submissionPayload(survey, filler)), 'SURVEY_NOT_OPEN');
      assert.equal((await documents(survey)).length, 2);
      assert.deepEqual(await raw(survey), closed);
      assert.equal(closed.revision, locked.revision + 1);
      assert.equal(closed.firstSubmittedAt.getTime(), locked.firstSubmittedAt.getTime());
    });

    await run('I11 首份受理后作者编辑被发布冻结拒绝，原版本提交成功', async () => {
      const survey = await publishedSurvey(owner);
      const questions = structuredClone(survey.questions);
      questions[0].title = '作者不能修改已发布题目';
      await gated(survey, 1, async gate => {
        const request = send(filler, survey, submissionPayload(survey, filler));
        await gate.wait();
        const rejected = await writeSurvey(owner, `/${survey.id}`, { revision: survey.revision, questions }, 'patch').expect(409);
        assert.equal(rejected.body.error.code, 'CONTENT_LOCKED');
        gate.release();
        assert.equal((await request).status, 201);
      });
      const [document] = await assertFrozen(survey, 1);
      assert.equal(document.definitionRevision, survey.definitionRevision);
    });

    await run('I11/I13 首份受理后作者关闭：冲突重试重新受理并拒绝，不留下冻结', async () => {
      const survey = await publishedSurvey(owner);
      const body = submissionPayload(survey, filler);
      let closed;
      await gated(survey, 1, async gate => {
        const request = send(filler, survey, body);
        await gate.wait();
        await writeSurvey(owner, `/${survey.id}/close`, { revision: survey.revision }).expect(200);
        closed = await raw(survey);
        gate.release();
        failure(await request, 'SURVEY_NOT_OPEN');
      });
      assert.deepEqual(await raw(survey), closed);
      assert.equal(closed.contentLocked, true);
      assert.equal(closed.firstSubmittedAt, null);
      assert.deepEqual(await documents(survey), []);
      const reopened = (await writeSurvey(owner, `/${survey.id}/reopen`, { revision: closed.revision }).expect(200)).body.data;
      assert.equal((await send(filler, survey, body)).status, 201);
      await assertFrozen(reopened, 1);
    });

    await run('I11/I13 首份与元信息写冲突：真实回调重试后以新受理时刻成功', async () => {
      const survey = await publishedSurvey(owner);
      const body = submissionPayload(survey, filler);
      const firstAcceptedAt = clock.now();
      const gate = acceptedGate(1);
      const attempts = [];
      let edited, saved;
      submissionHooks.afterAccepted = async context => {
        attempts.push({ attempt: context.attempt, session: context.session, revision: context.survey.revision });
        await gate.enter(context);
      };
      try {
        const request = send(filler, survey, body);
        await gate.wait();
        edited = (await writeSurvey(owner, `/${survey.id}`, { revision: survey.revision, title: '元信息与首份竞争' }, 'patch').expect(200)).body.data;
        clock.advance(1);
        gate.release();
        saved = await request;
      } finally {
        gate.release();
        await Promise.allSettled([...pending]);
        resetHooks();
      }
      assert.equal(saved.status, 201, JSON.stringify(saved.body));
      assert.deepEqual(attempts.map(context => context.attempt), [1, 2]);
      assert.deepEqual(attempts.map(context => context.revision), [survey.revision, edited.revision]);
      assert.equal(attempts[0].session, attempts[1].session);
      assert.equal(saved.body.data.submittedAt, new Date(firstAcceptedAt + 1).toISOString());
      const [document] = await assertFrozen(edited, 1);
      assert.equal(document.requestId, body.requestId);
      assert.equal(document._id.toHexString(), saved.body.data.submissionId);
      assert.equal(document.submittedAt.getTime(), firstAcceptedAt + 1);
    });

    await run('I13 首份受理后元信息写冲突且恰好截止：重试必须重取受理时间', async () => {
      const deadline = clock.now() + 1;
      const survey = await publishedSurvey(owner, { deadlineAt: new Date(deadline).toISOString() });
      let edited;
      await gated(survey, 1, async gate => {
        const request = send(filler, survey, submissionPayload(survey, filler));
        await gate.wait();
        await writeSurvey(owner, `/${survey.id}`, { revision: survey.revision, title: '仅元信息变更以制造真实写冲突' }, 'patch').expect(200);
        edited = await raw(survey);
        clock.advance(1);
        gate.release();
        failure(await request, 'SURVEY_NOT_OPEN');
      });
      assert.equal(edited.definitionRevision, survey.definitionRevision);
      assert.equal(edited.contentLocked, true);
      assert.equal(edited.firstSubmittedAt, null);
      assert.deepEqual(await raw(survey), edited);
      assert.deepEqual(await documents(survey), []);
    });

    await run('I11 反顺序首份先提交：作者旧 revision 编辑失败且已保存版本一致', async () => {
      const survey = await publishedSurvey(owner);
      const saved = await send(filler, survey, submissionPayload(survey, filler));
      assert.equal(saved.status, 201);
      const frozen = await raw(survey);
      const questions = structuredClone(survey.questions);
      questions[0].title = '不应覆盖首份的题目';
      const changed = await writeSurvey(owner, `/${survey.id}`, { revision: survey.revision, questions }, 'patch');
      failure(changed, 'REVISION_CONFLICT');
      assert.deepEqual(await raw(survey), frozen);
      const [document] = await assertFrozen(survey, 1);
      assert.equal(document.definitionRevision, survey.definitionRevision);
      assert.equal(document._id.toHexString(), saved.body.data.submissionId);
      assert.deepEqual(frozen.questions, survey.questions);
    });

    assert.deepEqual(errors, [], '服务不得记录未处理的数据库或会话错误');
  } finally {
    resetHooks();
    await Promise.allSettled([...pending]);
    // The helper verifies the exact randomly generated database name before drop.
    await resource.cleanup();
  }
});
