import { React, Material } from './host';

/**
 * @returns Responsive styles for native dialogs while this configuration is open
 */
export function AdminLayout(): unknown {
    return React.createElement(Material.GlobalStyles, {
        styles: {
            '@media (max-width: 600px)': {
                '.MuiDialog-root .MuiDialog-paper': {
                    margin: 8,
                    width: 'calc(100% - 16px)',
                    maxWidth: 'calc(100% - 16px)',
                    maxHeight: 'calc(100% - 16px)',
                },
            },
            '#ar_dialog_selectid_title': {
                // The native selector forces a single-line title through an inline style.
                whiteSpace: 'normal !important',
                overflowWrap: 'anywhere',
            },
            '.MuiDialog-paper[aria-labelledby="cron-dialog-title"] .MuiTextField-root': {
                minWidth: 64,
            },
        },
    });
}
