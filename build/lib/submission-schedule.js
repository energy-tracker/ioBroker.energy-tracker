"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.submissionSchedule = submissionSchedule;
const node_schedule_1 = require("node-schedule");
function submissionSchedule(expression, submit) {
    if (typeof expression !== 'string') {
        return null;
    }
    const fields = expression.trim().split(/\s+/);
    if (fields.length !== 5 && fields.length !== 6) {
        return null;
    }
    const cron = fields.length === 5 ? `${Math.round(Math.random() * 59)} ${fields.join(' ')}` : fields.join(' ');
    return (0, node_schedule_1.scheduleJob)(cron, submit);
}
