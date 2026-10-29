import { ObjectId } from 'mongodb';
import { AppError } from '../errors.js';
import { oid, fields, missing, pageQuery, paged } from './library-common.js';

export function createQuestionStatisticsService({ db, library }) {
  async function context(userId, questionId, versionId) {
    const reference = { questionId: oid(questionId).toHexString(), versionId: oid(versionId).toHexString() };
    const survey = await db.collection('surveys').findOne({ ownerId: oid(userId), questions: { $elemMatch: { 'reference.questionId': reference.questionId, 'reference.versionId': reference.versionId } } });
    if (!survey) await library.access(userId, questionId);
    const version = await library.version(questionId, versionId);
    return { reference, version };
  }
  function base(userId, reference) {
    return [
      { $lookup: { from: 'surveys', let: { sid: '$surveyId' }, pipeline: [
        { $match: { ownerId: oid(userId), $expr: { $eq: ['$_id', '$$sid'] } } },
        { $unwind: '$questions' },
        { $match: { 'questions.reference.questionId': reference.questionId, 'questions.reference.versionId': reference.versionId } },
        { $project: { title: 1, questionId: '$questions.id' } },
      ], as: 'survey' } },
      { $unwind: '$survey' }, { $unwind: '$answers' },
      { $match: { $expr: { $and: [
        { $eq: ['$answers.questionId', '$survey.questionId'] },
        { $in: ['$answers.questionId', '$effectivePath'] },
        { $ne: ['$answers.value', null] }, { $ne: ['$answers.value', ''] }, { $ne: ['$answers.value', []] },
      ] } } },
    ];
  }
  return {
    async statistics(userId, questionId, versionId, query = {}) {
      fields(query, [], true);
      const { reference, version } = await context(userId, questionId, versionId);
      const [result] = await db.collection('submissions').aggregate([...base(userId, reference), { $facet: {
        metric: [{ $group: { _id: null, answeredCount: { $sum: 1 }, average: { $avg: '$answers.value' } } }],
        options: ['single_choice', 'multiple_choice'].includes(version.content.type) ? [{ $unwind: '$answers.value' }, { $group: { _id: '$answers.value', count: { $sum: 1 } } }] : [{ $match: { _id: null } }],
      } }]).toArray();
      const answeredCount = result.metric[0]?.answeredCount ?? 0;
      const data = { questionId, versionId, number: version.number, type: version.content.type, title: version.content.title, answeredCount };
      if (version.content.type === 'number') data.average = result.metric[0]?.average ?? null;
      if (['single_choice', 'multiple_choice'].includes(version.content.type)) data.options = version.content.options.map(o => {
        const count = result.options.find(r => r._id === o.id)?.count ?? 0;
        return { ...o, count, percentage: answeredCount ? count / answeredCount * 100 : null };
      });
      return data;
    },
    async answers(userId, questionId, versionId, query = {}) {
      const { reference } = await context(userId, questionId, versionId);
      const scope = `version-answers:${userId}:${questionId}:${versionId}`;
      const { after, limit } = pageQuery(query, scope);
      const pipeline = base(userId, reference);
      if (after !== null) {
        if (!after || typeof after !== 'object' || Object.keys(after).sort().join(',') !== 'id,submittedAt' || typeof after.submittedAt !== 'string' || !Number.isFinite(new Date(after.submittedAt).getTime()) || new Date(after.submittedAt).toISOString() !== after.submittedAt || typeof after.id !== 'string' || !/^[a-f0-9]{24}$/.test(after.id)) throw new AppError(400, 'INVALID_CURSOR', '回答游标错误');
        pipeline.push({ $match: { $or: [{ submittedAt: { $lt: new Date(after.submittedAt) } }, { submittedAt: new Date(after.submittedAt), _id: { $lt: new ObjectId(after.id) } }] } });
      }
      pipeline.push({ $sort: { submittedAt: -1, _id: -1 } }, { $limit: limit + 1 }, { $project: { submittedAt: 1, anonymous: 1, value: '$answers.value', survey: 1, respondentId: { $cond: ['$anonymous', '$$REMOVE', '$respondentId'] } } });
      const rows = await db.collection('submissions').aggregate(pipeline).toArray();
      const ids = rows.filter(r => !r.anonymous && r.respondentId).map(r => r.respondentId);
      const users = await db.collection('users').find({ _id: { $in: ids } }, { projection: { username: 1 } }).toArray();
      const items = rows.map(r => ({ submissionId: r._id.toHexString(), submittedAt: r.submittedAt.toISOString(), anonymous: r.anonymous, respondent: !r.anonymous && users.find(u => u._id.equals(r.respondentId)) ? { username: users.find(u => u._id.equals(r.respondentId)).username } : null, value: r.value, survey: { id: r.survey._id.toHexString(), title: r.survey.title, questionId: r.survey.questionId } }));
      return paged(items, limit, scope, r => ({ id: r.submissionId, submittedAt: r.submittedAt }));
    },
    async frequencies(userId, questionId, versionId, query = {}) {
      const { reference, version } = await context(userId, questionId, versionId);
      if (version.content.type !== 'number') throw new AppError(422, 'INVALID_TYPE', '仅数字题提供数值频次');
      const scope = `version-frequencies:${userId}:${questionId}:${versionId}`;
      const { after, limit } = pageQuery(query, scope);
      if (after !== null && (typeof after !== 'number' || !Number.isFinite(after))) throw new AppError(400, 'INVALID_CURSOR', '数值游标错误');
      const pipeline = [...base(userId, reference), { $group: { _id: '$answers.value', count: { $sum: 1 } } }];
      if (after !== null) pipeline.push({ $match: { _id: { $gt: after } } });
      pipeline.push({ $sort: { _id: 1 } }, { $limit: limit + 1 });
      const rows = await db.collection('submissions').aggregate(pipeline).toArray();
      return paged(rows.map(r => ({ value: r._id, count: r.count })), limit, scope, r => r.value);
    },
  };
}
