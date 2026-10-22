import { request } from './api.js';

const form = document.querySelector('#auth-form');
const mode = form.dataset.mode;
const submitButton = document.querySelector('#submit-button');
const status = document.querySelector('#form-status');
const errorBox = document.querySelector('#form-error');
const username = document.querySelector('#username');
const password = document.querySelector('#password');
let submitting = false;

if (mode === 'login') {
  const params = new URLSearchParams(location.search);
  const notice = document.querySelector('#page-notice');
  const notices = {
    registered: '注册成功，请使用新账号登录。',
    expired: '请登录后查看个人问卷列表；原会话可能已到期。',
    logout: '已退出登录。',
  };
  for (const [key, message] of Object.entries(notices)) {
    if (params.get(key) === '1') {
      notice.textContent = message;
      notice.hidden = false;
      break;
    }
  }
}

function clearErrors() {
  errorBox.hidden = true;
  errorBox.textContent = '';
  for (const input of [username, password]) {
    input.removeAttribute('aria-invalid');
    const hint = document.querySelector(`#${input.name}-error`);
    hint.textContent = '';
    hint.hidden = true;
  }
}

function showError(error) {
  errorBox.textContent = error.message || '操作未能完成，请稍后重试。';
  errorBox.hidden = false;
  let firstInvalid;
  const details = Array.isArray(error.details) ? [...error.details] : [];
  if (error.code === 'USERNAME_TAKEN') details.push({ field: 'username', message: '该用户名已被占用，请更换用户名。' });
  for (const detail of details) {
    const field = detail?.field || detail?.path;
    if (field !== 'username' && field !== 'password') continue;
    const input = field === 'username' ? username : password;
    const hint = document.querySelector(`#${field}-error`);
    input.setAttribute('aria-invalid', 'true');
    hint.textContent = detail.message || '请检查此字段。';
    hint.hidden = false;
    firstInvalid ||= input;
  }
  (firstInvalid || errorBox).focus();
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (submitting) return;
  clearErrors();
  submitting = true;
  submitButton.disabled = true;
  username.readOnly = true;
  password.readOnly = true;
  form.setAttribute('aria-busy', 'true');
  status.textContent = mode === 'login' ? '正在登录…' : '正在注册…';
  try {
    // Keep raw values: native minlength/maxlength count UTF-16, not Unicode code points.
    await request(`/auth/${mode}`, { method: 'POST', body: { username: username.value, password: password.value } });
    password.value = '';
    if (mode === 'login') {
      location.replace('/surveys.html');
      return;
    }
    form.hidden = true;
    const success = document.querySelector('#register-success');
    success.hidden = false;
    success.focus();
    status.textContent = '';
  } catch (error) {
    status.textContent = '';
    showError(error);
  } finally {
    submitting = false;
    submitButton.disabled = false;
    username.readOnly = false;
    password.readOnly = false;
    form.setAttribute('aria-busy', 'false');
  }
});

submitButton.disabled = false;
status.textContent = '';
