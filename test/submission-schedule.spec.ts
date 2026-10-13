import { expect } from 'chai';
import sinon from 'sinon';
import { type Job } from 'node-schedule';
import { submissionSchedule } from '../src/lib/submission-schedule';

describe('Independent reading submission schedule', () => {
    let clock: sinon.SinonFakeTimers;
    let job: Job | null;
    const start = new Date(2026, 0, 1, 12, 0, 0).getTime();
    beforeEach(() => {
        clock = sinon.useFakeTimers({ now: start });
        sinon.stub(Math, 'random').returns(0.5);
    });
    afterEach(() => {
        job?.cancel();
        job = null;
        sinon.restore();
    });

    it('keeps five-field CRON scheduling with the ioBroker cloud jitter', async () => {
        // Arrange
        const submit = sinon.stub().resolves();

        // Act
        job = submissionSchedule('1 * * * *', submit);
        const nextRun = job?.nextInvocation()?.getTime();
        const callsAfterScheduling = submit.callCount;
        await clock.tickAsync(89_999);
        const callsBeforeDeadline = submit.callCount;
        await clock.tickAsync(1);

        // Assert
        expect(nextRun).to.equal(new Date(2026, 0, 1, 12, 1, 30).getTime());
        expect(callsAfterScheduling).to.equal(0);
        expect(callsBeforeDeadline).to.equal(0);
        expect(submit).to.have.been.calledOnce;
    });

    it('keeps explicitly selected seconds and supports whitespace', async () => {
        // Arrange
        const submit = sinon.stub().resolves();

        // Act
        job = submissionSchedule('  15   * * * * *  ', submit);
        const nextRun = job?.nextInvocation()?.getTime();
        await clock.tickAsync(15_000);

        // Assert
        expect(nextRun).to.equal(start + 15_000);
        expect(submit).to.have.been.calledOnce;
    });

    it('cancels future sends without a startup send or catch-up', async () => {
        // Arrange
        const submit = sinon.stub().resolves();
        job = submissionSchedule('0 11 * * *', submit);
        const nextRun = job?.nextInvocation()?.getTime();

        // Act
        job?.cancel();
        await clock.tickAsync(86_400_000);

        // Assert
        expect(nextRun).to.equal(new Date(2026, 0, 2, 11, 0, 30).getTime());
        expect(submit).not.to.have.been.called;
    });

    for (const expression of ['', 'broken', '* *', '99 * * * *']) {
        it(`rejects invalid CRON '${expression}' without creating a running job`, () => {
            // Arrange
            const submit = sinon.stub().resolves();

            // Act
            job = submissionSchedule(expression, submit);

            // Assert
            expect(job).to.equal(null);
            expect(submit).not.to.have.been.called;
        });
    }
});
