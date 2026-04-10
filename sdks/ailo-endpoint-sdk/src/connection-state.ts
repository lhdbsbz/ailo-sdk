export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'closing';

export interface StateTransition {
  from: ConnectionState;
  to: ConnectionState;
  timestamp: number;
  reason?: string;
}

export type StateChangeListener = (transition: StateTransition) => void;

export class ConnectionFSM {
  private _state: ConnectionState = 'disconnected';
  private listeners: StateChangeListener[] = [];
  private history: StateTransition[] = [];

  get state(): ConnectionState {
    return this._state;
  }

  get isConnected(): boolean {
    return this._state === 'connected';
  }

  get isConnecting(): boolean {
    return this._state === 'connecting' || this._state === 'reconnecting';
  }

  get isDisconnected(): boolean {
    return this._state === 'disconnected';
  }

  canTransitionTo(newState: ConnectionState): boolean {
    const allowed: Record<ConnectionState, ConnectionState[]> = {
      disconnected: ['connecting'],
      connecting: ['connected', 'disconnected', 'reconnecting'],
      connected: ['disconnected', 'reconnecting', 'closing'],
      reconnecting: ['connected', 'disconnected', 'connecting'],
      closing: ['disconnected'],
    };
    return allowed[this._state].includes(newState);
  }

  transition(newState: ConnectionState, reason?: string): boolean {
    if (!this.canTransitionTo(newState)) {
      return false;
    }

    const transition: StateTransition = {
      from: this._state,
      to: newState,
      timestamp: Date.now(),
      reason,
    };

    this.history.push(transition);
    this._state = newState;

    for (const listener of this.listeners) {
      try {
        listener(transition);
      } catch {
        // ignore listener errors
      }
    }

    return true;
  }

  forceTransition(newState: ConnectionState, reason?: string): void {
    const transition: StateTransition = {
      from: this._state,
      to: newState,
      timestamp: Date.now(),
      reason,
    };

    this.history.push(transition);
    this._state = newState;

    for (const listener of this.listeners) {
      try {
        listener(transition);
      } catch {
        // ignore listener errors
      }
    }
  }

  onStateChange(listener: StateChangeListener): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  getHistory(): StateTransition[] {
    return [...this.history];
  }

  reset(): void {
    this._state = 'disconnected';
    this.history = [];
  }
}
