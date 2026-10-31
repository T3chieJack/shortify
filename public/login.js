'use strict';

const form = document.getElementById('login-form');
const username = document.getElementById('username');
const password = document.getElementById('password');
const toggle = document.getElementById('password-toggle');
const submit = document.getElementById('submit');
const buttonLabel = submit.querySelector('.button-label');
const slashes = submit.querySelector('.slashes');
const defaultLabel = buttonLabel.textContent;
const alertStates = ['error', 'locked', 'offline'];

let busy = false;

function setPasswordVisible(visible) {
  password.type = visible ? 'text' : 'password';
  toggle.textContent = visible ? 'Hide' : 'Show';
  toggle.setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
}

function setFieldError(field, hasError) {
  const error = document.getElementById(field.id + '-error');
  error.hidden = !hasError;
  if (hasError) {
    field.setAttribute('aria-invalid', 'true');
    field.setAttribute('aria-describedby', error.id);
  } else {
    field.removeAttribute('aria-invalid');
    field.removeAttribute('aria-describedby');
  }
}

function setState(state) {
  const loading = state === 'loading';
  const success = state === 'success';

  form.querySelectorAll('[data-msg]').forEach((msg) => {
    msg.hidden = msg.dataset.msg !== state;
  });

  busy = loading || success;
  username.readOnly = busy;
  password.readOnly = busy;
  toggle.disabled = busy;

  if (busy) {
    submit.setAttribute('aria-disabled', 'true');
  } else {
    submit.removeAttribute('aria-disabled');
  }
  form.setAttribute('aria-busy', String(loading));
  slashes.hidden = !loading;

  if (loading) buttonLabel.textContent = submit.dataset.labelLoading;
  else if (success) buttonLabel.textContent = submit.dataset.labelSuccess;
  else buttonLabel.textContent = defaultLabel;

  [username, password].forEach((field) => {
    field.removeAttribute('aria-invalid');
    field.removeAttribute('aria-describedby');
    document.getElementById(field.id + '-error').hidden = true;
  });

  if (alertStates.includes(state)) {
    username.setAttribute('aria-describedby', 'msg-' + state);
    password.setAttribute('aria-describedby', 'msg-' + state);
  }
  if (state === 'error') {
    username.setAttribute('aria-invalid', 'true');
    password.setAttribute('aria-invalid', 'true');
  }
}

function validate() {
  const usernameEmpty = username.value.trim() === '';
  const passwordEmpty = password.value === '';
  setFieldError(username, usernameEmpty);
  setFieldError(password, passwordEmpty);
  if (usernameEmpty) username.focus();
  else if (passwordEmpty) password.focus();
  return !usernameEmpty && !passwordEmpty;
}

form.addEventListener('submit', (event) => {
  if (busy) {
    event.preventDefault();
    return;
  }

  setState(null);

  if (!validate()) {
    event.preventDefault();
    return;
  }

  setPasswordVisible(false);
  setState('loading');

});

toggle.addEventListener('click', () => {
  setPasswordVisible(password.type === 'password');
  password.focus();
});

[username, password].forEach((field) => {
  field.addEventListener('input', () => {
    field.removeAttribute('aria-invalid');
    document.getElementById(field.id + '-error').hidden = true;
  });
});

window.addEventListener('pageshow', (event) => {
  if (event.persisted) setState(null);
});

form.noValidate = true;
toggle.hidden = false;
