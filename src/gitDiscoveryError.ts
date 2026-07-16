export class GitDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitDiscoveryError";
  }
}
