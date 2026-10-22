import request from 'supertest';

export async function registerAndLogin(app, username = 'test_user', password = ' pass word ') {
  const agent = request.agent(app);
  const initial = await agent.get('/api/auth/csrf').expect(200);
  const initialToken = initial.body.data.csrfToken;
  const registered = await agent.post('/api/auth/register').set('X-CSRF-Token', initialToken).send({ username, password }).expect(201);
  const logged = await agent.post('/api/auth/login').set('X-CSRF-Token', initialToken).send({ username, password }).expect(200);
  return { agent, user: registered.body.data, csrfToken: logged.body.data.csrfToken, login: logged };
}
