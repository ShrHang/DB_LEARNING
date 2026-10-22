export function createSubmissionRepository(db) {
  const collection = db.collection('submissions');
  return {
    findRequest: (surveyId, respondentId, requestId, session) => collection.findOne({ surveyId, respondentId, requestId }, { session }),
    insert: (document, session) => collection.insertOne(document, { session }),
  };
}
