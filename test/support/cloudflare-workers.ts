export class WorkflowEntrypoint<Environment = unknown, _Parameters = unknown> {
  protected env: Environment;

  constructor(_context: unknown, env: Environment) {
    this.env = env;
  }

  async run(_event: unknown, _step: unknown): Promise<unknown> {
    throw new Error("WorkflowEntrypoint.run must be implemented by the test subject");
  }
}

export type WorkflowEvent<T> = {
  instanceId: string;
  payload: T;
};

export interface WorkflowStep {
  do<T>(name: string, callback: () => Promise<T>): Promise<T>;
  do<T>(name: string, options: unknown, callback: () => Promise<T>): Promise<T>;
}
