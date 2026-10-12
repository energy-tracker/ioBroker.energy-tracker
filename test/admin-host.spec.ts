import { expect } from 'chai';
import sinon from 'sinon';
import { init, React, Button, InfoBox, I18n, type ShareScope } from '../src-admin/host';

describe('Admin shared UI modules', () => {
    for (const library of ['@iobroker/adapter-react-v5', '@iobroker/gui-components']) {
        it(`uses the host instances from ${library}`, async () => {
            // Arrange
            const react = { createElement: sinon.stub(), useEffect: sinon.stub() };
            const button = sinon.stub();
            const infoBox = sinon.stub();
            const i18n = { t: sinon.stub(), getLanguage: () => 'de' };
            const scope: ShareScope = {
                react: { host: { get: () => () => react } },
                '@mui/material': { host: { get: () => () => ({ Button: button }) } },
                [library]: { host: { get: () => () => ({ InfoBox: infoBox, I18n: i18n }) } },
            };

            // Act
            await init(scope);

            // Assert
            expect(React).to.equal(react);
            expect(Button).to.equal(button);
            expect(InfoBox).to.equal(infoBox);
            expect(I18n).to.equal(i18n);
        });
    }

    it('keeps the already loaded React singleton when the host lists multiple versions', async () => {
        // Arrange
        const unused = sinon.stub();
        const react = {};
        const scope: ShareScope = {
            react: { unused: { get: unused }, loaded: { loaded: true, get: () => Promise.resolve(() => react) } },
            '@mui/material': { host: { get: () => () => ({ Button: sinon.stub() }) } },
            '@iobroker/gui-components': { host: { get: () => () => ({ InfoBox: sinon.stub(), I18n: {} }) } },
        };

        // Act
        await init(scope);

        // Assert
        expect(React).to.equal(react);
        expect(unused).not.to.have.been.called;
    });

    it('reports an unavailable host module without providing a second bundled UI library', async () => {
        // Arrange
        const scope: ShareScope = {};
        let error: unknown;

        // Act
        try {
            await init(scope);
        } catch (caught) {
            error = caught;
        }

        // Assert
        expect(error).to.be.instanceOf(Error);
        expect((error as Error).message).to.equal('ioBroker Admin does not share react');
    });
});
