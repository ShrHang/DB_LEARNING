import { ObjectId } from 'mongodb';
import { AppError } from '../errors.js';
import { oid, fields, revision, missing, conflict, transaction, pageQuery, paged, afterId } from './library-common.js';
export function createBankService({ db, client, clock = { now: () => Date.now() }, library }) {
  const banks = db.collection('questionBanks');
  const items = db.collection('questionBankItems');
  async function own(userId, bankId, session) {
    const bank = await banks.findOne({ _id: oid(bankId), ownerId: oid(userId) }, { session });
    if (!bank) throw missing();
    return bank;
  }
  function nameOf(name) {
    if (typeof name !== 'string' || !name.trim() || [...name].length > 100) throw new AppError(422, 'VALIDATION_FAILED', '题库名称须为 1—100 字符');
    return name.trim();
  }
  const serialize = b => ({ id: b._id.toHexString(), name: b.name, revision: b.revision, createdAt: b.createdAt });
  return {
    async create(userId, body) {
      fields(body, ['name']);
      const bank = { _id: new ObjectId(), ownerId: oid(userId), name: nameOf(body.name), revision: 1, createdAt: new Date(clock.now()), schemaVersion: 1 };
      await banks.insertOne(bank);
      return serialize(bank);
    },
    async list(userId, query = {}) {
      const scope = `banks:${userId}`;
      const { limit, after } = pageQuery(query, scope);
      const rows = await banks.find({ ownerId: oid(userId), ...afterId(after) }).sort({ _id: -1 }).limit(limit + 1).toArray();
      return paged(rows.map(serialize), limit, scope);
    },
    async change(userId, bankId, body, remove = false) {
      fields(body, remove ? ['revision'] : ['revision', 'name']); revision(body);
      return transaction(client, async session => {
        const bank = await own(userId, bankId, session);
        if (bank.revision !== body.revision) throw conflict();
        if (remove) {
          await banks.deleteOne({ _id: bank._id }, { session });
          await items.deleteMany({ bankId: bank._id }, { session });
          return null;
        }
        bank.name = nameOf(body.name); bank.revision++;
        await banks.updateOne({ _id: bank._id }, { $set: { name: bank.name, revision: bank.revision } }, { session });
        return serialize(bank);
      });
    },
    async add(userId, bankId, body) {
      fields(body, ['revision', 'questionId']); revision(body);
      return transaction(client, async session => {
        const bank = await own(userId, bankId, session);
        if (bank.revision !== body.revision) throw conflict();
        const q = await library.access(userId, body.questionId, session, { usable: true, touch: true });
        await items.updateOne({ bankId: bank._id, questionId: q._id }, { $setOnInsert: { _id: new ObjectId(), createdAt: new Date(clock.now()), schemaVersion: 1 } }, { session, upsert: true });
        await banks.updateOne({ _id: bank._id }, { $inc: { revision: 1 } }, { session });
        return { revision: bank.revision + 1 };
      });
    },
    async remove(userId, bankId, questionId, body) {
      fields(body, ['revision']); revision(body);
      return transaction(client, async session => {
        const bank = await own(userId, bankId, session);
        if (bank.revision !== body.revision) throw conflict();
        await items.deleteOne({ bankId: bank._id, questionId: oid(questionId) }, { session });
        await banks.updateOne({ _id: bank._id }, { $inc: { revision: 1 } }, { session });
        return { revision: bank.revision + 1 };
      });
    },
    async listItems(userId, bankId, query = {}) {
      const bank = await own(userId, bankId);
      const scope = `bank-items:${bankId}`;
      const { limit, after } = pageQuery(query, scope);
      const rows = await items.find({ bankId: bank._id, ...afterId(after) }).sort({ _id: -1 }).limit(limit + 1).toArray();
      const result = [];
      for (const row of rows) {
        let question = null;
        try { question = await library.get(userId, row.questionId.toHexString()); } catch (e) { if (e.status !== 404) throw e; }
        result.push({ id: row._id.toHexString(), questionId: row.questionId.toHexString(), question, available: Boolean(question && !question.archived) });
      }
      return { ...paged(result, limit, scope), bank: serialize(bank) };
    },
  };
}
