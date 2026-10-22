// Successful submissions already contain normalized, final-path answers. Keep
// this predicate shared by aggregation and answer pagination, including 0.
function answered(answer) {
  return { $and: [
    { $ne: [`${answer}.value`, null] },
    { $ne: [`${answer}.value`, ''] },
    { $ne: [`${answer}.value`, []] },
    { $in: [`${answer}.questionId`, '$effectivePath'] },
  ] };
}

export function createStatisticsRepository(db) {
  const submissions = db.collection('submissions');

  async function withRespondents(rows) {
    // Anonymous identities never enter the users query. Query only the selected
    // page, with a username projection, and leave missing real-name users null.
    const ids = [...new Map(rows.filter(row => row.anonymous === false && row.respondentId)
      .map(row => [row.respondentId.toHexString(), row.respondentId])).values()];
    const users = ids.length ? await db.collection('users').find(
      { _id: { $in: ids } }, { projection: { _id: 1, username: 1 } },
    ).toArray() : [];
    const usernames = new Map(users.map(user => [user._id.toHexString(), user.username]));
    return rows.map(row => {
      const { respondentId, ...publicRow } = row;
      const username = row.anonymous === false && respondentId ? usernames.get(respondentId.toHexString()) : undefined;
      return { ...publicRow, respondent: typeof username === 'string' ? { username } : null };
    });
  }

  const summaryProjection = {
    _id: 1, submittedAt: 1, anonymous: 1,
    respondentId: { $cond: [{ $eq: ['$anonymous', false] }, '$respondentId', '$$REMOVE'] },
  };

  return {
    async aggregate(surveyId, questions) {
      const answerStages = [
        { $unwind: '$answers' },
        { $match: { 'answers.questionId': { $in: questions.map(question => question.id) }, $expr: answered('$answers') } },
      ];
      const choiceIds = questions.filter(question => ['single_choice', 'multiple_choice'].includes(question.type)).map(question => question.id);
      const [result] = await submissions.aggregate([
        { $match: { surveyId } },
        { $project: { _id: 0, answers: 1, effectivePath: 1 } },
        { $facet: {
          total: [{ $count: 'count' }],
          questions: [
            ...answerStages,
            { $group: { _id: '$answers.questionId', answeredCount: { $sum: 1 }, average: { $avg: '$answers.value' } } },
          ],
          options: [
            ...answerStages,
            { $match: { 'answers.questionId': { $in: choiceIds } } },
            { $unwind: '$answers.value' },
            { $group: { _id: { questionId: '$answers.questionId', optionId: '$answers.value' }, count: { $sum: 1 } } },
          ],
        } },
      ]).toArray();
      return { totalSubmissions: result.total[0]?.count ?? 0, questions: result.questions, options: result.options };
    },

    async page({ surveyId, questionId = null, before, limit }) {
      const filter = { surveyId };
      if (before) filter.$or = [
        { submittedAt: { $lt: before.submittedAt } },
        { submittedAt: before.submittedAt, _id: { $lt: before.id } },
      ];
      if (questionId !== null) filter.$expr = { $anyElementTrue: [{ $map: {
        input: '$answers', as: 'answer',
        in: { $and: [{ $eq: ['$$answer.questionId', { $literal: questionId }] }, answered('$$answer')] },
      } }] };
      const projection = { ...summaryProjection };
      if (questionId !== null) projection.value = { $arrayElemAt: [{ $map: {
        input: { $filter: { input: '$answers', as: 'answer', cond: { $eq: ['$$answer.questionId', { $literal: questionId }] } } },
        as: 'answer', in: '$$answer.value',
      } }, 0] };
      const rows = await submissions.aggregate([
        { $match: filter },
        { $sort: { submittedAt: -1, _id: -1 } },
        { $limit: limit + 1 },
        { $project: projection },
      ]).toArray();
      return { rows: await withRespondents(rows.slice(0, limit)), hasMore: rows.length > limit };
    },

    async find(surveyId, submissionId) {
      const [row] = await submissions.aggregate([
        { $match: { surveyId, _id: submissionId } },
        { $project: { ...summaryProjection, definitionRevision: 1, effectivePath: 1, answers: 1 } },
      ]).toArray();
      return row ? (await withRespondents([row]))[0] : null;
    },
  };
}
