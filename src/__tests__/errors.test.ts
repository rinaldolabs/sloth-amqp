import { describe, expect, it } from 'vitest';
import {
  errMessage,
  SlothConnectError,
  SlothError,
  SlothPublishError,
  SlothTimeoutError,
  SlothValidationError,
  toSlothError,
} from '../errors.js';

describe('errMessage', () => {
  it('extracts the message from an Error', () => {
    expect(errMessage(new Error('boom'))).toBe('boom');
  });

  it('stringifies a non-Error value', () => {
    expect(errMessage('plain string')).toBe('plain string');
    expect(errMessage(42)).toBe('42');
  });

  it('does not throw for a null-prototype object (String() itself throws)', () => {
    expect(errMessage(Object.create(null))).toBe('[unstringifiable thrown value]');
  });

  it('does not throw when toString throws', () => {
    const hostile = {
      toString(): string {
        throw new Error('gotcha');
      },
    };
    expect(errMessage(hostile)).toBe('[unstringifiable thrown value]');
  });
});

describe('toSlothError', () => {
  it('passes SlothError instances through verbatim', () => {
    const original = new SlothValidationError('bad input');
    expect(toSlothError(original, undefined, SlothPublishError)).toBe(original);
  });

  it('passes DOMExceptions (abort/timeout) through verbatim', () => {
    const timeout = new DOMException('timed out', 'TimeoutError');
    expect(toSlothError(timeout, undefined, SlothConnectError)).toBe(timeout);
  });

  it('passes a caller abort reason through verbatim by identity', () => {
    const reason = { custom: 'shutdown' };
    const ac = new AbortController();
    ac.abort(reason);
    expect(toSlothError(reason, ac.signal, SlothConnectError)).toBe(reason);
  });

  it('wraps a foreign error in the given class with the cause chained', () => {
    const foreign = new Error('ECONNRESET');
    const wrapped = toSlothError(foreign, undefined, SlothConnectError);
    expect(wrapped).toBeInstanceOf(SlothConnectError);
    if (!(wrapped instanceof SlothConnectError)) throw new Error('unreachable');
    expect(wrapped.message).toBe('ECONNRESET');
    expect(wrapped.cause).toBe(foreign);
  });

  it('wraps a foreign error even when a signal exists but did not fire', () => {
    const ac = new AbortController();
    const wrapped = toSlothError(new Error('boom'), ac.signal, SlothPublishError);
    expect(wrapped).toBeInstanceOf(SlothPublishError);
  });
});

describe('SlothError hierarchy', () => {
  const cases = [
    { Cls: SlothValidationError, code: 'SLOTH_VALIDATION' },
    { Cls: SlothPublishError, code: 'SLOTH_PUBLISH' },
    { Cls: SlothTimeoutError, code: 'SLOTH_TIMEOUT' },
    { Cls: SlothConnectError, code: 'SLOTH_CONNECT' },
  ] as const;

  for (const { Cls, code } of cases) {
    it(`${Cls.name} is a SlothError/Error with code ${code} and its own name`, () => {
      const err = new Cls('something failed');
      expect(err).toBeInstanceOf(SlothError);
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(Cls);
      expect(err.code).toBe(code);
      expect(err.name).toBe(Cls.name);
      expect(err.message).toBe('something failed');
    });
  }

  it('chains the cause when provided', () => {
    const root = new Error('root');
    const err = new SlothConnectError('wrapped', { cause: root });
    expect(err.cause).toBe(root);
  });

  it('narrows by instanceof for caller branching', () => {
    const err: SlothError = new SlothTimeoutError('timed out');
    if (err instanceof SlothTimeoutError) {
      expect(err.code).toBe('SLOTH_TIMEOUT');
    } else {
      throw new Error('instanceof narrowing failed');
    }
  });
});
