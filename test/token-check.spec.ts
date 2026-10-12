import { expect } from 'chai';
import sinon from 'sinon';
import 'sinon-chai';
import { TokenCheck } from '../src-admin/token-check';
import { accessTokenInput } from '../src/lib/token-input';
import { deferred, TEST_ACCESS_TOKEN } from './helpers';
import type { TokenInformation } from '../src/lib/token-status';

describe('Configuration token checks', () => {
    let clock: sinon.SinonFakeTimers;
    let send: sinon.SinonStub;
    let update: sinon.SinonStub;
    const information: TokenInformation = {
        status: 'valid',
        token: { displayName: 'ioBroker', expiresAt: '2027-01-01T00:00:00.000Z', scopes: ['read:measuring-device'] },
        nextCheckAt: 0,
    };
    beforeEach(() => {
        clock = sinon.useFakeTimers({ now: 1_800_000_000_000, toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        send = sinon.stub().resolves({ ...information, nextCheckAt: Date.now() + 61_000 });
        update = sinon.stub();
    });
    afterEach(() => sinon.restore());

    it('checks a complete draft token after the input pause', async () => {
        // Arrange
        const check = new TokenCheck(TEST_ACCESS_TOKEN, send, update);
        check.start(500);
        await clock.tickAsync(499);
        const premature = send.called;

        // Act
        await clock.tickAsync(1);

        // Assert
        expect(premature).to.equal(false);
        expect(send).to.have.been.calledOnceWith('getTokenInfo', TEST_ACCESS_TOKEN);
        expect(update.lastCall.args[0].info.token).to.deep.equal(information.token);
    });

    it('checks immediately when opening a saved configuration', async () => {
        // Arrange
        const check = new TokenCheck(TEST_ACCESS_TOKEN, send, update);

        // Act
        check.start(0);
        await clock.tickAsync(0);

        // Assert
        expect(send).to.have.been.calledOnceWith('getTokenInfo', TEST_ACCESS_TOKEN);
    });

    for (const token of [
        '',
        '89d4f886-7eec-4f47-a8b2-41251b083d42',
        TEST_ACCESS_TOKEN.slice(0, -1),
        `bnVsbA.e30.${'A'.repeat(86)}`,
    ]) {
        it(`does not check an incomplete or malformed credential (${token.length} characters)`, async () => {
            // Arrange
            const check = new TokenCheck(token, send, update);

            // Act
            check.start(500);
            await clock.tickAsync(500);
            await check.check();

            // Assert
            expect(send).not.to.have.been.called;
            expect(accessTokenInput(token)).to.equal(null);
        });
    }

    it('trims pasted whitespace without changing the case-sensitive credential', () => {
        // Arrange
        const pasted = `  ${TEST_ACCESS_TOKEN}\n`;

        // Act
        const token = accessTokenInput(pasted);

        // Assert
        expect(token).to.equal(TEST_ACCESS_TOKEN);
    });

    it('cancels a debounced check when the input changes or the view closes', async () => {
        // Arrange
        const check = new TokenCheck(TEST_ACCESS_TOKEN, send, update);
        check.start(500);

        // Act
        check.dispose();
        await clock.tickAsync(500);

        // Assert
        expect(send).not.to.have.been.called;
    });

    it('ignores a late response for a replaced credential', async () => {
        // Arrange
        const pending = deferred<TokenInformation>();
        send.returns(pending.promise);
        const check = new TokenCheck(TEST_ACCESS_TOKEN, send, update);
        check.start(0);
        await clock.tickAsync(0);
        update.resetHistory();

        // Act
        check.dispose();
        pending.resolve(information);
        await clock.tickAsync(0);

        // Assert
        expect(update).not.to.have.been.called;
    });

    it('does not poll after a successful check and rechecks immediately when requested', async () => {
        // Arrange
        const check = new TokenCheck(TEST_ACCESS_TOKEN, send, update);
        check.start(0);
        await clock.tickAsync(0);
        await clock.tickAsync(61_001);
        const automaticCalls = send.callCount;

        // Act
        await check.check();

        // Assert
        expect(automaticCalls).to.equal(1);
        expect(send).to.have.been.calledTwice;
        expect(send.lastCall.args).to.deep.equal(['checkToken', TEST_ACCESS_TOKEN]);
    });

    it('defers a pending input check until the shared allowance permits it', async () => {
        // Arrange
        send.onFirstCall().resolves({
            status: 'unknown',
            token: null,
            error: 'tokenCheckWait',
            nextCheckAt: Date.now() + 61_000,
        });
        const check = new TokenCheck(TEST_ACCESS_TOKEN, send, update);
        check.start(0);
        await clock.tickAsync(0);
        await check.check();
        const prematureCalls = send.callCount;

        // Act
        await clock.tickAsync(61_001);

        // Assert
        expect(prematureCalls).to.equal(1);
        expect(send).to.have.been.calledTwice;
        expect(update.lastCall.args[0].info.token).to.deep.equal(information.token);
    });

    it('does not automatically retry a server error after the cooldown', async () => {
        // Arrange
        send.resolves({ status: 'error', token: null, error: 'tokenCheckWait', nextCheckAt: Date.now() + 61_000 });
        const check = new TokenCheck(TEST_ACCESS_TOKEN, send, update);
        check.start(0);
        await clock.tickAsync(0);

        // Act
        await clock.tickAsync(600_000);

        // Assert
        expect(send).to.have.been.calledOnce;
        expect(update.lastCall.args[0].waiting).to.equal(false);
    });

    it('shows a transport failure without leaving the view busy', async () => {
        // Arrange
        send.rejects(new Error('Disconnected'));
        const check = new TokenCheck(TEST_ACCESS_TOKEN, send, update);

        // Act
        check.start(0);
        await clock.tickAsync(0);

        // Assert
        expect(update.lastCall.args[0].busy).to.equal(false);
        expect(update.lastCall.args[0].info.error).to.equal('tokenCheckUnavailable');
    });
});
