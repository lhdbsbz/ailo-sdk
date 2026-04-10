import { describe, it, expect, beforeEach } from 'vitest';
import { ConnectionFSM, type StateTransition } from '../src/connection-state.js';

describe('ConnectionFSM', () => {
  let fsm: ConnectionFSM;

  beforeEach(() => {
    fsm = new ConnectionFSM();
  });

  it('should start in disconnected state', () => {
    expect(fsm.state).toBe('disconnected');
    expect(fsm.isDisconnected).toBe(true);
    expect(fsm.isConnected).toBe(false);
    expect(fsm.isConnecting).toBe(false);
  });

  it('should allow transition from disconnected to connecting', () => {
    expect(fsm.canTransitionTo('connecting')).toBe(true);
    expect(fsm.canTransitionTo('connected')).toBe(false);
    expect(fsm.canTransitionTo('reconnecting')).toBe(false);
  });

  it('should transition from disconnected to connecting', () => {
    const result = fsm.transition('connecting', 'user initiated');
    expect(result).toBe(true);
    expect(fsm.state).toBe('connecting');
    expect(fsm.isConnecting).toBe(true);
  });

  it('should not allow invalid transitions', () => {
    expect(fsm.transition('connected')).toBe(false);
    expect(fsm.state).toBe('disconnected');
  });

  it('should track state history', () => {
    fsm.transition('connecting');
    fsm.transition('connected');
    
    const history = fsm.getHistory();
    expect(history).toHaveLength(2);
    expect(history[0].from).toBe('disconnected');
    expect(history[0].to).toBe('connecting');
    expect(history[1].from).toBe('connecting');
    expect(history[1].to).toBe('connected');
  });

  it('should notify listeners on state change', () => {
    const transitions: StateTransition[] = [];
    fsm.onStateChange((t) => transitions.push(t));

    fsm.transition('connecting');
    fsm.transition('connected');

    expect(transitions).toHaveLength(2);
    expect(transitions[0].to).toBe('connecting');
    expect(transitions[1].to).toBe('connected');
  });

  it('should allow unsubscribing from state changes', () => {
    const transitions: StateTransition[] = [];
    const unsubscribe = fsm.onStateChange((t) => transitions.push(t));

    fsm.transition('connecting');
    unsubscribe();
    fsm.transition('connected');

    expect(transitions).toHaveLength(1);
  });

  it('should support full connection lifecycle', () => {
    expect(fsm.transition('connecting')).toBe(true);
    expect(fsm.state).toBe('connecting');
    
    expect(fsm.transition('connected')).toBe(true);
    expect(fsm.state).toBe('connected');
    
    expect(fsm.transition('reconnecting')).toBe(true);
    expect(fsm.state).toBe('reconnecting');
    
    expect(fsm.transition('connected')).toBe(true);
    expect(fsm.state).toBe('connected');
    
    expect(fsm.transition('closing')).toBe(true);
    expect(fsm.state).toBe('closing');
    
    expect(fsm.transition('disconnected')).toBe(true);
    expect(fsm.state).toBe('disconnected');
  });

  it('should force transition regardless of rules', () => {
    fsm.forceTransition('connected', 'forced');
    expect(fsm.state).toBe('connected');
  });

  it('should reset to initial state', () => {
    fsm.transition('connecting');
    fsm.transition('connected');
    fsm.reset();
    
    expect(fsm.state).toBe('disconnected');
    expect(fsm.getHistory()).toHaveLength(0);
  });

  it('should store reason in transition', () => {
    fsm.transition('connecting', 'manual connect');
    const history = fsm.getHistory();
    expect(history[0].reason).toBe('manual connect');
  });
});
