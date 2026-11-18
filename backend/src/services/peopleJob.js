// After a call or chat job finishes: find the people in it (best effort). People already in People get
// this conversation on their timeline; new people go to the inbox for the owner to add or ignore.
//
// Runs only after the job's own results are saved, and never changes the job or its response. A
// failure is logged; the call analysis is unaffected.

import * as repo from "../db/repository.js";
import { linkJobToPerson, personRef, recordPeople } from "../db/people.js";
import { extractAll } from "./people.js";
import { recordDepartmentIdeas } from "../db/departmentIdeas.js";
import { conversationDone } from "../db/notifications.js";
import { linesFromMessages, linesFromSegments } from "./pulse.js";
import { getLogger } from "../util.js";

const logger = getLogger("app.services.people");

const running = new Map(); // job id -> promise (tests wait on it)

/** Numbered lines of a finished job, with speaker names applied. */
export function jobLines(job) {
  const r = job.result ?? {};
  if (job.kind === "whatsapp") return linesFromMessages(r.messages ?? []);
  return linesFromSegments(r.tamil_segments ?? [], r.english_segments ?? []);
}

/** What a conversation was about, for a timeline entry the AI did not describe. */
function aboutText(job, name) {
  const a = job.result?.analysis;
  const summary = a?.available ? (a.data?.final_summary || a.data?.summary) : null;
  const text = summary ? String(summary).replace(/\s+/g, " ").trim() : "";
  return (text || `${job.kind === "whatsapp" ? "Chat" : "Call"} added to ${name}'s timeline.`).slice(0, 1000);
}

/** Start finding people for a completed job once `saved` (its database writes) has finished. */
export function afterJob(job, saved) {
  if (job.status !== "completed" || !repo.enabled()) return;
  const p = Promise.resolve(saved)
    .catch(() => {})
    .then(async () => {
      const target = job.personId ? await personRef(job.personId) : null;
      try {
        const lines = jobLines(job);
        // When it was uploaded: "by Friday" in the call becomes that Friday's date.
        const { people, departmentIdeas } = await extractAll(lines, undefined, { callAt: job.createdAt ? job.createdAt * 1000 : Date.now() });
        const { linked, suggested, opportunities } = await recordPeople(job.id, job.kind, people, lines, target);
        // New departments someone said the owner should create: to the inbox (never changes People).
        const ideas = await recordDepartmentIdeas(job.id, departmentIdeas).catch((exc) => {
          logger.warning(`People: department ideas could not be stored for job ${job.id} (${exc?.message ?? "error"})`);
          return 0;
        });
        logger.info(`People: ${people.length} found in job ${job.id} (${linked.length} already in People, ${suggested} to the inbox, ${opportunities} opportunit${opportunities === 1 ? "y" : "ies"} captured, ${ideas} new department idea${ideas === 1 ? "" : "s"})`);
        return people;
      } catch (exc) {
        logger.warning(`People: could not be found for job ${job.id} (${exc?.message ?? exc?.name ?? "error"})`);
        return null;
      } finally {
        // Uploaded on a person's page: it is on their timeline even if the AI did not name them.
        if (target) {
          await linkJobToPerson(job.id, job.kind, target.id, aboutText(job, target.name)).catch((exc) =>
            logger.warning(`People: could not add job ${job.id} to the person's timeline (${exc?.message ?? "error"})`),
          );
        }
        // The bell: "Call analysed", new opportunities, people for the inbox (never fails the job).
        await conversationDone(job.id).catch(() => 0);
      }
    })
    .catch(() => null)
    .finally(() => running.delete(job.id));
  running.set(job.id, p);
}

/** Resolves when people extraction for a job has finished (or immediately if none is running). */
export const peopleDone = (jobId) => running.get(jobId) ?? Promise.resolve(null);
