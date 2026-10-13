import { scheduleJob, type Job } from 'node-schedule';

/**
 * Keep ioBroker's cloud scheduling jitter for five-field CRON expressions.
 * Six-field expressions retain their explicit seconds.
 *
 * @param expression Reading submission CRON in the host's local time zone
 * @param submit Independent reading submission task
 * @returns A cancellable job, or null when the schedule is invalid
 */
export function submissionSchedule(expression: string, submit: () => Promise<void>): Job | null {
    if (typeof expression !== 'string') {
        return null;
    }
    const fields = expression.trim().split(/\s+/);
    if (fields.length !== 5 && fields.length !== 6) {
        return null;
    }
    const cron = fields.length === 5 ? `${Math.round(Math.random() * 59)} ${fields.join(' ')}` : fields.join(' ');
    return scheduleJob(cron, submit);
}
