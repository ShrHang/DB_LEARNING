export function createSubmissionRepository(db) {
  const collection = db.collection('submissions');
  return {
    findRequest: (surveyId, respondentId, requestId, session) => collection.findOne({ surveyId, respondentId, requestId }, { session }),
    insert: (document, session) => collection.insertOne(document, { session }),
    count: surveyId => collection.countDocuments({ surveyId }),
    removeSurvey: (surveyId, session) => collection.deleteMany({ surveyId }, { session }),
  };
}
