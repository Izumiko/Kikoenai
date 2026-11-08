// Replacement for the `limit-promise` package. At most `max` calls run at
// once; the rest wait in a FIFO queue. The queue drains in the same order the
// calls were submitted, and a rejected call does not stop the ones behind it.

type Task = () => void;

export default class LimitPromise {
  readonly #max: number;
  #count = 0;
  readonly #taskQueue: Task[] = [];

  constructor(max: number) {
    this.#max = max;
  }

  call<A extends unknown[], R>(fn: (...args: A) => R | Promise<R>, ...args: A): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      const run = () => {
        // Take the slot before invoking `fn`, and release it in `finally`, so
        // even a synchronous throw cannot strand the queue.
        this.#count += 1;
        let result: Promise<R>;
        try {
          result = Promise.resolve(fn(...args));
        } catch (err) {
          result = Promise.reject(err);
        }
        result.then(resolve, reject).finally(() => {
          this.#count -= 1;
          const next = this.#taskQueue.shift();
          if (next) next();
        });
      };

      if (this.#count >= this.#max) {
        this.#taskQueue.push(run);
      } else {
        run();
      }
    });
  }
}
