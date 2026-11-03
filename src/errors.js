export class DispatchError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
