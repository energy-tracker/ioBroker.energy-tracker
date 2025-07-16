import chai, { assert, expect } from 'chai';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import type { AxiosInstance } from 'axios';
import { EnergyTrackerApi } from './energy-tracker-api';

chai.use(sinonChai);

describe('EnergyTrackerApi', () => {
    let adapterMock: sinon.SinonStubbedInstance<ioBroker.Adapter>;
    let axiosInstanceMock: sinon.SinonStubbedInstance<AxiosInstance>;
    let api: EnergyTrackerApi;

    beforeEach(() => {
        adapterMock = {
            getForeignStateAsync: sinon.stub(),
            setState: sinon.stub().resolves(),
            config: {
                bearerToken: 'test-token',
            },
            log: {
                info: sinon.stub(),
                warn: sinon.stub(),
                error: sinon.stub(),
            },
        } as unknown as sinon.SinonStubbedInstance<ioBroker.Adapter>;

        axiosInstanceMock = {
            post: sinon.stub(),
        } as unknown as sinon.SinonStubbedInstance<AxiosInstance>;

        api = new EnergyTrackerApi(adapterMock, axiosInstanceMock);
    });

    afterEach(() => {
        sinon.restore();
    });

    it('should send a valid reading (allowRounding=false)', async () => {
        // Arrange
        const device = {
            deviceId: 'abc123',
            sourceState: 'test.state',
            allowRounding: false,
        } satisfies ioBroker.AdapterDevice;
        adapterMock.getForeignStateAsync.resolves({
            val: 123.456,
            ack: true,
            ts: Date.now(),
            lc: Date.now(),
            from: 'system.adapter.test',
        });

        // Act
        await api.sendReading(device);

        // Assert
        assert.isTrue(axiosInstanceMock.post.calledOnce);
        const [url, body, config] = axiosInstanceMock.post.firstCall.args;
        expect(url).to.equal('/v1/devices/abc123/meter-readings');
        expect(body).to.deep.equal({ value: 123.456 });
        expect(config?.headers?.Authorization).to.equal('Bearer test-token');
        expect(config?.params).to.deep.equal({});
        expect(adapterMock.log.info).to.have.been.calledWithMatch('[test.state] Reading sent: 123.456');
    });

    it('should include allowRounding=true when enabled', async () => {
        // Arrange
        const device = {
            deviceId: 'round1',
            sourceState: 'round.state',
            allowRounding: true,
        } satisfies ioBroker.AdapterDevice;
        adapterMock.getForeignStateAsync.resolves({
            val: 123.789,
            ack: true,
            ts: Date.now(),
            lc: Date.now(),
            from: 'system.adapter.test',
        });

        // Act
        await api.sendReading(device);

        // Assert
        expect(axiosInstanceMock.post.firstCall.args[2]?.params).to.deep.equal({ allowRounding: true });
    });

    it('should warn on invalid state value', async () => {
        // Arrange
        const device = {
            deviceId: 'invalid1',
            sourceState: 'missing.state',
            allowRounding: false,
        } satisfies ioBroker.AdapterDevice;
        adapterMock.getForeignStateAsync.resolves({
            val: 'not-a-number',
            ack: true,
            ts: 1,
            lc: 1,
            from: 'system.adapter.test',
        });

        // Act
        await api.sendReading(device);

        // Assert
        expect(adapterMock.log.warn).to.have.been.calledWithMatch('Invalid or missing state');
        assert.isFalse(axiosInstanceMock.post.called);
    });

    it('should handle 400 Bad Request gracefully', async () => {
        // Arrange
        const device = {
            deviceId: 'fail400',
            sourceState: 'error.state',
            allowRounding: false,
        } satisfies ioBroker.AdapterDevice;
        adapterMock.getForeignStateAsync.resolves({
            val: 1,
            ack: true,
            ts: Date.now(),
            lc: Date.now(),
            from: 'system.adapter.test',
        });

        axiosInstanceMock.post.rejects({
            isAxiosError: true,
            response: {
                status: 400,
                data: { message: 'Test bad request' },
            },
        });

        // Act
        await api.sendReading(device);

        // Assert
        expect(adapterMock.log.warn).to.have.been.calledWithMatch('[error.state] Bad Request: Test bad request');
    });

    it('should log error on 401 Unauthorized', async () => {
        // Arrange
        const device = {
            deviceId: 'unauth',
            sourceState: 'unauth.state',
            allowRounding: false,
        } satisfies ioBroker.AdapterDevice;
        adapterMock.getForeignStateAsync.resolves({
            val: 7,
            ack: true,
            ts: Date.now(),
            lc: Date.now(),
            from: 'system.adapter.test',
        });

        axiosInstanceMock.post.rejects({
            isAxiosError: true,
            response: {
                status: 401,
                data: {},
            },
        });

        // Act
        await api.sendReading(device);

        // Assert
        expect(adapterMock.log.error).to.have.been.calledWithMatch(
            '[unauth.state] Unauthorized: Check your access token',
        );
    });

    it('should log error on 403 Forbidden', async () => {
        // Arrange
        const device = {
            deviceId: 'forbidden',
            sourceState: 'forbidden.state',
            allowRounding: false,
        } satisfies ioBroker.AdapterDevice;
        adapterMock.getForeignStateAsync.resolves({
            val: 7,
            ack: true,
            ts: Date.now(),
            lc: Date.now(),
            from: 'system.adapter.test',
        });

        axiosInstanceMock.post.rejects({
            isAxiosError: true,
            response: {
                status: 403,
                data: {},
            },
        });

        // Act
        await api.sendReading(device);

        // Assert
        expect(adapterMock.log.error).to.have.been.calledWithMatch(
            '[forbidden.state] Forbidden: Insufficient permissions',
        );
    });

    it('should warn on 429 Too Many Requests with retry-after', async () => {
        // Arrange
        const device = {
            deviceId: 'ratelimit',
            sourceState: 'rate.state',
            allowRounding: false,
        } satisfies ioBroker.AdapterDevice;
        adapterMock.getForeignStateAsync.resolves({
            val: 7,
            ack: true,
            ts: Date.now(),
            lc: Date.now(),
            from: 'system.adapter.test',
        });

        axiosInstanceMock.post.rejects({
            isAxiosError: true,
            response: {
                status: 429,
                data: {},
                headers: { 'retry-after': '42' },
            },
        });

        // Act
        await api.sendReading(device);

        // Assert
        expect(adapterMock.log.warn).to.have.been.calledWithMatch(
            '[rate.state] Too many requests: Rate limit exceeded – Retry after 42 seconds.',
        );
    });

    it('should warn on 429 Too Many Requests without retry-after', async () => {
        // Arrange
        const device = {
            deviceId: 'ratelimit2',
            sourceState: 'rate2.state',
            allowRounding: false,
        } satisfies ioBroker.AdapterDevice;
        adapterMock.getForeignStateAsync.resolves({
            val: 7,
            ack: true,
            ts: Date.now(),
            lc: Date.now(),
            from: 'system.adapter.test',
        });

        axiosInstanceMock.post.rejects({
            isAxiosError: true,
            response: {
                status: 429,
                data: {},
                headers: {},
            },
        });

        // Act
        await api.sendReading(device);

        // Assert
        expect(adapterMock.log.warn).to.have.been.calledWithMatch(
            '[rate2.state] Too many requests: Rate limit exceeded',
        );
    });

    it('should warn on 5xx server error', async () => {
        // Arrange
        const device = {
            deviceId: 'servererror',
            sourceState: 'server.state',
            allowRounding: false,
        } satisfies ioBroker.AdapterDevice;
        adapterMock.getForeignStateAsync.resolves({
            val: 7,
            ack: true,
            ts: Date.now(),
            lc: Date.now(),
            from: 'system.adapter.test',
        });

        axiosInstanceMock.post.rejects({
            isAxiosError: true,
            response: {
                status: 502,
                data: { message: 'Bad Gateway' },
            },
        });

        // Act
        await api.sendReading(device);

        // Assert
        expect(adapterMock.log.warn).to.have.been.calledWithMatch('[server.state] Server error 502: Bad Gateway');
    });

    it('should warn on unexpected HTTP status', async () => {
        // Arrange
        const device = {
            deviceId: 'unexpected',
            sourceState: 'unexpected.state',
            allowRounding: false,
        } satisfies ioBroker.AdapterDevice;
        adapterMock.getForeignStateAsync.resolves({
            val: 7,
            ack: true,
            ts: Date.now(),
            lc: Date.now(),
            from: 'system.adapter.test',
        });

        axiosInstanceMock.post.rejects({
            isAxiosError: true,
            response: {
                status: 418,
                data: { message: "I'm a teapot" },
            },
        });

        // Act
        await api.sendReading(device);

        // Assert
        expect(adapterMock.log.warn).to.have.been.calledWithMatch(
            "[unexpected.state] Unexpected HTTP 418: I'm a teapot",
        );
    });

    it('should error on network error (no status)', async () => {
        // Arrange
        const device = {
            deviceId: 'network',
            sourceState: 'network.state',
            allowRounding: false,
        } satisfies ioBroker.AdapterDevice;
        adapterMock.getForeignStateAsync.resolves({
            val: 7,
            ack: true,
            ts: Date.now(),
            lc: Date.now(),
            from: 'system.adapter.test',
        });

        axiosInstanceMock.post.rejects({
            isAxiosError: true,
            message: 'Network down',
            response: undefined,
        });

        // Act
        await api.sendReading(device);

        // Assert
        expect(adapterMock.log.error).to.have.been.calledWithMatch('[network.state] Network error: Network down');
    });

    it('should error on unexpected (non-axios) error', async () => {
        // Arrange
        const device = {
            deviceId: 'nonaxios',
            sourceState: 'nonaxios.state',
            allowRounding: false,
        } satisfies ioBroker.AdapterDevice;
        adapterMock.getForeignStateAsync.resolves({
            val: 7,
            ack: true,
            ts: Date.now(),
            lc: Date.now(),
            from: 'system.adapter.test',
        });

        axiosInstanceMock.post.rejects(new Error('Something went wrong'));

        await api.sendReading(device);

        // Assert
        expect(adapterMock.log.error).to.have.been.calledWithMatch(
            '[nonaxios.state] Unexpected error: Error: Something went wrong',
        );
    });

    it('should warn and not call API if state is null', async () => {
        // Arrange
        const device = {
            deviceId: 'nullstate',
            sourceState: 'null.state',
            allowRounding: false,
        } satisfies ioBroker.AdapterDevice;
        adapterMock.getForeignStateAsync.resolves(null);

        // Act
        await api.sendReading(device);

        // Assert
        expect(adapterMock.log.warn).to.have.been.calledWithMatch('Invalid or missing state');
        assert.isFalse(axiosInstanceMock.post.called);
    });

    it('should set info.connection to true on success', async () => {
        // Arrange
        const device = {
            deviceId: 'ok',
            sourceState: 'ok.state',
            allowRounding: false,
        } satisfies ioBroker.AdapterDevice;
        adapterMock.getForeignStateAsync.resolves({
            val: 42,
            ack: true,
            ts: Date.now(),
            lc: Date.now(),
            from: 'system.adapter.test',
        });
        axiosInstanceMock.post.resolves({});

        // Act
        await api.sendReading(device);

        // Assert
        expect(adapterMock.setState).to.have.been.calledWith('info.connection', {
            val: true,
            ack: true,
        });
    });

    it('should set info.connection to false on error', async () => {
        const device = {
            deviceId: 'fail',
            sourceState: 'fail.state',
            allowRounding: false,
        } satisfies ioBroker.AdapterDevice;
        adapterMock.getForeignStateAsync.resolves({
            val: 42,
            ack: true,
            ts: Date.now(),
            lc: Date.now(),
            from: 'system.adapter.test',
        });
        axiosInstanceMock.post.rejects({
            isAxiosError: true,
            response: {
                status: 401,
                data: {},
            },
        });

        // Act
        await api.sendReading(device);

        // Assert
        expect(adapterMock.setState).to.have.been.calledWith('info.connection', {
            val: false,
            ack: true,
        });
    });
});
