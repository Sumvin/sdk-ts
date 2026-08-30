import { describe, expect, it } from 'vitest';
import { junoJwt, pintToken, sumvinPat } from './provider.js';

describe('junoJwt', () => {
  it('when: a getter supplies a token synchronously, this sets header "x-juno-jwt" and returns it', async () => {
    const provider = junoJwt(() => 'jwt-abc');

    expect(provider.header).toBe('x-juno-jwt');
    expect(await provider.getToken()).toBe('jwt-abc');
  });

  it('when: the getter is async, this awaits it rather than returning a Promise as the token', async () => {
    const provider = junoJwt(async () => 'jwt-async');

    const token = provider.getToken();
    expect(token).toBeInstanceOf(Promise);
    expect(await token).toBe('jwt-async');
  });

  it('when: the getter has no token yet (logged out), this resolves undefined rather than throwing', async () => {
    const provider = junoJwt(() => undefined);

    expect(await provider.getToken()).toBeUndefined();
  });

  it('when: the getter is called again after the session refreshes, this returns the fresh value — proving the token is never cached by the provider itself', async () => {
    let current = 'jwt-1';
    const provider = junoJwt(() => current);

    expect(await provider.getToken()).toBe('jwt-1');
    current = 'jwt-2';
    expect(await provider.getToken()).toBe('jwt-2');
  });
});

describe('sumvinPat', () => {
  it('when: constructed with a static string, this sets header "x-sumvin-pat" and returns that string', async () => {
    const provider = sumvinPat('pat-static');

    expect(provider.header).toBe('x-sumvin-pat');
    expect(await provider.getToken()).toBe('pat-static');
  });

  it('when: constructed with a sync getter, this calls it and returns its value', async () => {
    const provider = sumvinPat(() => 'pat-from-getter');

    expect(await provider.getToken()).toBe('pat-from-getter');
  });

  it('when: constructed with an async getter, this awaits it', async () => {
    const provider = sumvinPat(async () => 'pat-async');

    expect(await provider.getToken()).toBe('pat-async');
  });

  it('when: the getter yields undefined, this resolves undefined', async () => {
    const provider = sumvinPat(() => undefined);

    expect(await provider.getToken()).toBeUndefined();
  });
});

describe('pintToken', () => {
  it('when: constructed with a static string, this sets header "x-sumvin-pint-token" and returns that string', async () => {
    const provider = pintToken('pint-static');

    expect(provider.header).toBe('x-sumvin-pint-token');
    expect(await provider.getToken()).toBe('pint-static');
  });

  it('when: constructed with an async getter, this awaits it', async () => {
    const provider = pintToken(async () => 'pint-async');

    expect(await provider.getToken()).toBe('pint-async');
  });

  it('when: the getter yields undefined (no active PINT), this resolves undefined', async () => {
    const provider = pintToken(() => undefined);

    expect(await provider.getToken()).toBeUndefined();
  });
});
