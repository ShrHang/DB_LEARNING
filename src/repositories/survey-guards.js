import { ObjectId } from 'mongodb';

export function createSurveyGuardRepository(db) {
  const guards = db.collection('surveyGuards');
  return {
    insert: (surveyId, session) => guards.insertOne({ _id: surveyId, token: new ObjectId(), schemaVersion: 1 }, { session }),
    // A real change is essential: a no-op does not establish the write conflict
    // with a concurrent deletion. No upsert is permitted on runtime paths.
    touch: (surveyId, session) => guards.updateOne({ _id: surveyId }, { $set: { token: new ObjectId() } }, { session }),
    remove: (surveyId, session) => guards.deleteOne({ _id: surveyId }, { session }),
  };
}
