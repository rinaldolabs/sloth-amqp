import { describe, expect, it } from 'vitest';
import {
  errMessage,
  SlothConnectError,
  SlothError,
  SlothPublishError,
  SlothTimeoutError,
  SlothValidationError,
} from '../errors.js';

describe('errMessage', () => {
  it('extracts the message from an Error', () => {
    expect(errMessage(new Error('boom'))).toBe('boom');
  });

  it('stringifies a non-Error value', () => {
    expect(errMessage('plain string')).toBe('plain string');
    expect(errMessage(42)).toBe('42');
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
