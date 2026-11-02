import { afterEach, describe, expect, it } from 'vitest';
import { OAuthError } from '../../../src/oauth/errors.ts';
import { requestTokens } from '../../../src/oauth/token-endpoint.ts';
import { json, useServers } from '../../helpers/recording-server.ts';

const serve = useServers(afterEach);

describe('requestTokens', () => {
  it('reports a null body as a failed flow', async () => {
    const endpoint = await serve((_request, response) => json(response, 200, null));
    const request = requestTokens('Acme', endpoint.url, {});
    await expect(request).rejects.toBeInstanceOf(OAuthError);
    await expect(request).rejects.toMatchObject({ code: 'FLOW_FAILED' });
  });

  it('reports a body that is not JSON as a failed flow', async () => {
    const endpoint = await serve((_request, response) => void response.writeHead(200, { 'content-type': 'text/html' }).end('<html>maintenance</html>'));
    await expect(requestTokens('Acme', endpoint.url, {})).rejects.toMatchObject({ code: 'FLOW_FAILED', message: 'the Acme token response is not JSON' });
  });

  it('drops an optional token of the wrong type and keeps vendor fields', async () => {
    const endpoint = await serve((_request, response) =>
      json(response, 200, { access_token: 'at', refresh_token: 42, id_token: null, expires_in: '60', org_id: 'org_1' }),
    );
    expect(await requestTokens('Acme', endpoint.url, {})).toEqual({ access_token: 'at', expires_in: '60', org_id: 'org_1' });
  });
});
