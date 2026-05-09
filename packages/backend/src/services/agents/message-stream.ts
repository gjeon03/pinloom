// Controllable async source of user prompts for an in-flight agent run.
// Used by both adapters: Claude pipes it directly into the SDK's prompt
// AsyncIterable, Codex pulls one message per spawned `codex exec` turn.

import type { ImageInput } from '../runner-types.js';

export interface UserPrompt {
  text: string;
  images: ImageInput[];
}

export class UserPromptStream {
  private buffer: UserPrompt[] = [];
  private waiters: Array<(value: UserPrompt | null) => void> = [];
  private closed = false;

  push(prompt: UserPrompt): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(prompt);
    } else {
      this.buffer.push(prompt);
    }
  }

  /** Signals "no more messages will arrive" — pending iterators resolve to end. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waiters) w(null);
    this.waiters = [];
  }

  isClosed(): boolean {
    return this.closed;
  }

  hasPending(): boolean {
    return this.buffer.length > 0;
  }

  /** Pull next prompt; resolves to null when stream is closed and drained. */
  next(): Promise<UserPrompt | null> {
    if (this.buffer.length > 0) {
      return Promise.resolve(this.buffer.shift() ?? null);
    }
    if (this.closed) return Promise.resolve(null);
    return new Promise<UserPrompt | null>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<UserPrompt> {
    while (true) {
      const next = await this.next();
      if (next === null) return;
      yield next;
    }
  }
}
