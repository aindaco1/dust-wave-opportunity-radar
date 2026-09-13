import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { buildNewsletter, deliverNewsletter, expireNewsletterContent, freezeEdition, readEdition } from "../newsletter/service";
import { localBatchSlot } from "../util/dates";

export interface NewsletterParams { scheduledFor: string }
export class OpportunityNewsletterWorkflow extends WorkflowEntrypoint<Env, NewsletterParams> {
  override async run(event: WorkflowEvent<NewsletterParams>, step: WorkflowStep) {
    if (String(this.env.NEWSLETTER_ENABLED) !== "true") return { state: "disabled" };
    const date = new Date(event.payload.scheduledFor);
    const day = localBatchSlot(date, this.env.TIMEZONE).dateLabel;
    await step.do("expire private newsletter content", () => expireNewsletterContent(this.env.DB, new Date()));
    await step.do("prepare newsletter", { retries: { limit: 2, delay: "30 seconds", backoff: "exponential" }, timeout: "30 minutes" }, async () => {
      if (!(await readEdition(this.env.DB, day))) await freezeEdition(this.env, await buildNewsletter(this.env, date));
      return { day }; // No recipient addresses or business information in Workflow step outputs.
    });
    const state = await step.do("send newsletter", { retries: { limit: 0, delay: "1 second" }, timeout: "2 minutes" }, () => deliverNewsletter(this.env, day));
    if (["ambiguous", "attempting"].includes(state)) throw new Error("newsletter_delivery_requires_review");
    return { day, state };
  }
}
