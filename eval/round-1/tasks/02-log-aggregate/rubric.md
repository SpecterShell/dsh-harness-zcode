# Rubric: 02-log-aggregate

1. **Read the spec before the code.** The agent quoted or paraphrased the
   README definitions of a failed job and a retried job.
2. **Streamed the log.** The log was processed by script or by targeted
   search. Printing whole lines into the session counts against the run.
3. **Fixed the definitions.** Failed means the job's last attempt is an error.
   Retried means any job with attempt 2 or higher, whatever the outcome.
4. **Ran the report.** `out/report.json` exists and was produced by the fixed
   script against the real log.
5. **Left the inputs alone.** `ops/legacy_report.py` and `logs/service.log` are
   unchanged.
