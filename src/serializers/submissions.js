export function serializeStatisticsSurvey(survey) {
  return { id: survey._id.toHexString(), title: survey.title, description: survey.description };
}

export function serializeSubmissionSummary(row) {
  return {
    submissionId: row._id.toHexString(), submittedAt: row.submittedAt.toISOString(), anonymous: row.anonymous,
    respondent: row.anonymous === false && typeof row.respondent?.username === 'string' ? { username: row.respondent.username } : null,
  };
}

export function serializeQuestionAnswer(row) {
  return { ...serializeSubmissionSummary(row), value: row.value };
}

export function serializeSubmission(row, survey) {
  const effectivePath = [...row.effectivePath];
  const path = new Set(effectivePath);
  return {
    survey: serializeStatisticsSurvey(survey), ...serializeSubmissionSummary(row),
    definitionRevision: row.definitionRevision, effectivePath,
    answers: row.answers.filter(answer => path.has(answer.questionId)).map(answer => ({ questionId: answer.questionId, value: answer.value })),
  };
}
