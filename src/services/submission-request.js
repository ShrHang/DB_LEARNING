import { createHash } from 'node:crypto';
import { AppError } from '../errors.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = message => { throw new AppError(400, 'INVALID_REQUEST', message); };
function fields(value, allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) invalid('请求字段或类型不合法');
}

// Request-only normalization: never consult the current survey or its status.
export function parseSubmissionRequest(body) {
  fields(body, ['requestId', 'expectedUserId', 'definitionRevision', 'anonymous', 'answers']);
  if (typeof body.requestId !== 'string' || !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(body.requestId)) invalid('提交标识必须是UUID');
  if (typeof body.expectedUserId !== 'string' || !/^[a-f\d]{24}$/i.test(body.expectedUserId)) invalid('原账号标识无效');
  if (!Number.isSafeInteger(body.definitionRevision) || body.definitionRevision < 1 || typeof body.anonymous !== 'boolean' || !Array.isArray(body.answers)) invalid('定义版本、匿名方式或答案类型无效');
  const ids = new Set();
  const answers = body.answers.map(answer => {
    fields(answer, ['questionId', 'value']);
    if (typeof answer.questionId !== 'string' || !answer.questionId || !answer.questionId.isWellFormed() || ids.has(answer.questionId)) invalid('题目标识无效或重复');
    ids.add(answer.questionId);
    let value = answer.value ?? null;
    if (Array.isArray(value)) {
      if (value.some(item => typeof item !== 'string' || !item.isWellFormed()) || new Set(value).size !== value.length) invalid('多选答案必须是无重复的合法Unicode字符串数组');
      value = value.length ? [...value].sort() : null;
    } else if (typeof value === 'string') {
      if (!value.isWellFormed()) throw new AppError(422, 'ANSWER_INVALID', '文本包含无效的Unicode字符', [{ questionId: answer.questionId, field: `answers.${answer.questionId}`, message: '文本包含未配对的Unicode代理项' }]);
      if (!value.trim()) value = null;
    } else if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) invalid('答案必须是文本、有限安全数字、选项数组或空值');
    return { questionId: answer.questionId, value };
  }).sort((a, b) => a.questionId < b.questionId ? -1 : a.questionId > b.questionId ? 1 : 0);
  const canonical = { definitionRevision: body.definitionRevision, anonymous: body.anonymous, answers };
  const requestHash = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  return { ...canonical, requestHash, requestId: body.requestId.toLowerCase(), expectedUserId: body.expectedUserId.toLowerCase() };
}
