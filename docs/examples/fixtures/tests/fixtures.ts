import { test as base } from '@e2e-dev/web';
import type { App } from 'e2e';

export { expect } from 'e2e';

interface Project {
  readonly id: string;
  readonly name: string;
}

interface Task {
  readonly id: string;
  readonly title: string;
}

/** Calls the app's test API and fails on any status but 2xx. */
async function testApi(app: App, method: 'POST' | 'DELETE', path: string, body?: object): Promise<Response> {
  if (app.baseUrl === undefined) throw new Error('set app.url on the target');
  const response = await fetch(new URL(path, app.baseUrl), {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path} failed: HTTP ${response.status}`);
  return response;
}

/** A fresh project for each test, deleted after it. */
export const test = base.extend<{ project: Project }>({
  project: async ({ app }, use) => {
    const response = await testApi(app, 'POST', '/api/test/projects', { name: 'Launch plan' });
    const project = (await response.json()) as Project;
    await use(project);
    await testApi(app, 'DELETE', `/api/test/projects/${project.id}`);
  },
});

/** One task in that project. */
export const taskTest = test.extend<{ task: Task }>({
  task: async ({ app, project }, use) => {
    const response = await testApi(app, 'POST', `/api/test/projects/${project.id}/tasks`, {
      title: 'Write the announcement',
    });
    const task = (await response.json()) as Task;
    await use(task);
    await testApi(app, 'DELETE', `/api/test/tasks/${task.id}`);
  },
});
