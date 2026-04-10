import { describe, it, expect } from 'vitest';
import { EndpointError } from '../src/errors.js';

describe('EndpointError', () => {
  it('should create error with code and recoverable flag', () => {
    const err = new EndpointError('test error', 'NETWORK', true);
    expect(err.message).toBe('test error');
    expect(err.code).toBe('NETWORK');
    expect(err.recoverable).toBe(true);
    expect(err.name).toBe('EndpointError');
  });

  it('should create network error', () => {
    const err = EndpointError.network('connection failed');
    expect(err.code).toBe('NETWORK');
    expect(err.recoverable).toBe(true);
  });

  it('should create timeout error', () => {
    const err = EndpointError.timeout('handshake timeout');
    expect(err.code).toBe('TIMEOUT');
    expect(err.recoverable).toBe(true);
  });

  it('should create auth error', () => {
    const err = EndpointError.auth('invalid api key');
    expect(err.code).toBe('AUTH');
    expect(err.recoverable).toBe(false);
  });

  it('should create protocol error', () => {
    const err = EndpointError.protocol('invalid frame');
    expect(err.code).toBe('PROTOCOL');
    expect(err.recoverable).toBe(false);
  });

  it('should create not connected error', () => {
    const err = EndpointError.notConnected();
    expect(err.code).toBe('NOT_CONNECTED');
    expect(err.recoverable).toBe(true);
    expect(err.message).toBe('Not connected to server');
  });

  it('should create evicted error', () => {
    const err = EndpointError.evicted();
    expect(err.code).toBe('EVICTED');
    expect(err.recoverable).toBe(false);
  });

  it('should store cause', () => {
    const cause = new Error('original error');
    const err = EndpointError.network('wrapped', cause);
    expect(err.cause).toBe(cause);
  });
});
