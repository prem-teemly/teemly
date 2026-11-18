// Live end-to-end check against real Gemini on Vertex AI. Requires ADC to be configured.
//
// Run from backend/:
//   npm run live-check -- [path\to\recording.m4a]
//
// Checks, in order: credentials + model access, Tamil / Tanglish translation, meeting summary,
// and — if a recording is given — transcription
// of its first 2 minutes. Prints real model output so quality can be reviewed by a person.

import path from "node:path";

import * as analysis from "../src/services/analysis.js";
import * as gemini from "../src/services/gemini.js";
import * as transcription from "../src/services/transcription.js";

const show = (title, value) => console.log(`\n=== ${title}\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`);

const status = await gemini.checkConnection();
show("Connection / IAM", status);
if (!status.credentials.ok || !status.models.text?.ok) {
  console.log("\nStopping: fix the credentials / permission error above first.");
  process.exit(1);
}

show("Translate Tamil", await transcription.translateText("நாளைக்கு காலை பத்து மணிக்கு client meeting இருக்கு. Prem presentation ready பண்ணனும்."));
show("Translate Tanglish", await transcription.translateText("Budget approve aagiduchu, Friday kulla invoice anuppunga. Payment late aana penalty irukku."));

const sample =
  "Speaker 1: Hi Prem, naalaikku 5 mani-ku apram client call connect pannunga.\n" +
  "Speaker 2: Sari. Pricing slide update panniduren. Server migration issue innum fix aagala.\n" +
  "Speaker 1: Okay, migration next week Monday pannalaam nu decide pannalaam.";
show("Meeting summary", await analysis.analyzeText(sample, "meeting"));

const file = process.argv[2];
if (file) {
  const audio = (await transcription.loadAudio(file)).subarray(0, 120 * transcription.SAMPLE_RATE);
  const result = await transcription.transcribeAudio(file, audio);
  show(
    `Transcription of first 2 min of ${path.basename(file)} (model: ${result.model}, languages: ${result.languages})`,
    result.tamil_segments.map((o, i) => ({ start: o.start, end: o.end, speaker: o.speaker, original: o.text, english: result.english_segments[i].text })),
  );
} else {
  console.log("\n(No recording given: transcription not checked. Pass a file path to check it.)");
}
process.exit(0);
