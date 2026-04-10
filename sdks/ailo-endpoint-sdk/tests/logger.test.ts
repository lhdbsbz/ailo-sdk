import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConsoleLogger, NoopLogger } from '../src/logger.js';

describe('Logger', () => {
  let consoleSpy: {
    error: ReturnType<typeof vi.spyOn>;
    warn: ReturnType<typeof vi.spyOn>;
    log: ReturnType<typeof vi.spyOn>;
  };

  beforeEach(() => {
    consoleSpy = {
      error: vi.spyOn(console, 'error').mockImplementation(() => {}),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
      log: vi.spyOn(console, 'log').mockImplementation(() => {}),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('ConsoleLogger', () => {
    it('should log error with prefix', () => {
      const logger = new ConsoleLogger('[test]');
      logger.error('test_event', { key: 'value' });
      
      expect(consoleSpy.error).toHaveBeenCalled();
      const call = consoleSpy.error.mock.calls[0];
      expect(call[0]).toContain('[test]');
      expect(call[0]).toContain('[ERROR]');
      expect(call[0]).toContain('test_event');
    });

    it('should log warn with prefix', () => {
      const logger = new ConsoleLogger('[test]');
      logger.warn('warn_event');
      
      expect(consoleSpy.warn).toHaveBeenCalled();
    });

    it('should log info with prefix', () => {
      const logger = new ConsoleLogger('[test]');
      logger.info('info_event');
      
      expect(consoleSpy.log).toHaveBeenCalled();
    });

    it('should not log debug when DEBUG is not set', () => {
      delete process.env.DEBUG;
      const logger = new ConsoleLogger('[test]');
      logger.debug('debug_event');
      
      expect(consoleSpy.log).not.toHaveBeenCalled();
    });

    it('should log debug when DEBUG is set', () => {
      const originalDebug = process.env.DEBUG;
      process.env.DEBUG = '1';
      
      const logger = new ConsoleLogger('[test]');
      logger.debug('debug_event');
      
      expect(consoleSpy.log).toHaveBeenCalled();
      process.env.DEBUG = originalDebug;
    });
  });

  describe('NoopLogger', () => {
    it('should not log anything', () => {
      const logger = new NoopLogger();
      logger.error('test');
      logger.warn('test');
      logger.info('test');
      logger.debug('test');
      
      expect(consoleSpy.error).not.toHaveBeenCalled();
      expect(consoleSpy.warn).not.toHaveBeenCalled();
      expect(consoleSpy.log).not.toHaveBeenCalled();
    });
  });
});
