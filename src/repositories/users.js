import { ObjectId } from 'mongodb';

export function createUserRepository(db) {
  const users = db.collection('users');
  return {
    insert: user => users.insertOne(user),
    findByUsername: username => users.findOne({ username }, { collation: { locale: 'simple' } }),
    findById: id => ObjectId.isValid(id) ? users.findOne({ _id: new ObjectId(id) }) : null
  };
}
