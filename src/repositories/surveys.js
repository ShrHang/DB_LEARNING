import { Long } from 'mongodb';

const countFields = ['minSelections', 'maxSelections', 'minLength', 'maxLength'];
function storageQuestions(questions) {
  return questions.map(question => {
    const validation = { ...question.validation };
    for (const field of countFields) {
      const value = validation[field];
      if (Number.isSafeInteger(value) && value > 2147483647) validation[field] = Long.fromNumber(value);
    }
    return { ...question, validation };
  });
}

export async function findOwnSurveyPage(db, { ownerId, before, limit }) {
  const filter = { ownerId };
  if (before) filter.$or = [{ createdAt: { $lt: before.createdAt } }, { createdAt: before.createdAt, _id: { $lt: before.id } }];
  const projection = { _id: 1, title: 1, description: 1, status: 1, deadlineAt: 1, createdAt: 1, updatedAt: 1 };
  return db.collection('surveys').find(filter, { projection }).sort({ createdAt: -1, _id: -1 }).limit(limit + 1).toArray();
}

export function createSurveyRepository(db) {
  const surveys = db.collection('surveys');
  return {
    insert: (document, session) => surveys.insertOne({ ...document, questions: storageQuestions(document.questions) }, { session }),
    findOwn: (_id, ownerId, session) => surveys.findOne({ _id, ownerId }, { session }),
    findSlug: slug => surveys.findOne({ slug }),
    findId: (_id, session) => surveys.findOne({ _id }, { session }),
    freeze: (survey, acceptedAt, session) => surveys.updateOne({ _id: survey._id, definitionRevision: survey.definitionRevision, contentLocked: false }, { $set: { contentLocked: true, firstSubmittedAt: acceptedAt, updatedAt: acceptedAt }, $inc: { revision: 1 } }, { session }),
    removeOwn: (survey, session) => surveys.deleteOne({ _id: survey._id, ownerId: survey.ownerId, revision: survey.revision }, { session }),
    updateOwn: (filter, changes) => surveys.findOneAndUpdate(filter, { $set: { ...changes, ...(Object.hasOwn(changes, 'questions') ? { questions: storageQuestions(changes.questions) } : {}) }, $inc: { revision: 1 } }, { returnDocument: 'after', includeResultMetadata: false })
  };
}
