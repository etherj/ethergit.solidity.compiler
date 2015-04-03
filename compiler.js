define(function(require, exports, module) {
    main.consumes = ['Plugin', 'proc', 'settings', 'preferences', 'dialog.error'];
    main.provides = ['ethergit.solidity.compiler'];
    
    return main;

    function main(options, imports, register) {
        var Plugin = imports.Plugin;
        var proc = imports.proc;
        var settings = imports.settings;
        var prefs = imports.preferences;
        var errorDialog = imports['dialog.error'];

        var plugin = new Plugin('Ethergit', main.consumes);
        
        function load() {
            settings.on('read', function(){
                settings.setDefaults('user/ethergit-solidity-compiler', [
                    ['solc', 'solc']
                ]);
            }, plugin);
            
            prefs.add({
                'Run' : {
                    position: 500,
                    'Solidity': {
                        position: 100,
                        'Compiler Path': {
                            type: 'textbox',
                            setting: 'user/ethergit-solidity-compiler/@solc',
                            position: 100
                        }
                    }
                }
            }, plugin);
        }
        
        function solc(args, input, cb) {
            proc.spawn(
                settings.get('user/ethergit-solidity-compiler/@solc'),
                { args: args },
                function(err, process) {
                    if (err) return cb({ type: 'SYSTEM', message: err });
                    
                    var error = '';
                    process.stderr.on('data', function(chunk) {
                        error += chunk;
                    });
                    
                    var output = '';
                    process.stdout.on('data', function(chunk) {
                        output += chunk;
                    });
                    
                    process.stdin.end(input);
                    
                    process.on('exit', function() {
                        var err = null;
                        if (error.length !== 0) {
                            err = {
                                type: 'SYNTAX',
                                message: error
                            };
                        } else if (output.length === 0) {
                            err = {
                                type: 'SYSTEM',
                                message: 'Could not find ' + settings.get('user/ethergit-solidity-compiler/@solc') + '. Please, specify a path to Solidity compiler in the preferences.'
                            };
                        }
                        cb(err, output);
                    });
                }
            );
        }
        
        function binary(text, cb) {
            solc(['--binary', 'stdout'], text, function(err, output) {
                if (err) {
                    if (err.type === 'SYNTAX' || err.type === 'SYSTEM') {
                        errorDialog.show(err.message);
                        cb(err);
                    } else {
                        console.error('Unknown error: ' + err);
                        errorDialog.show('Unknown error occured. See details in devtools.');
                    }
                    return;
                }
                
                cb(null, output.match(/(\w+)$/gm)[0]);
            });
        }
        
        plugin.on('load', function() {
            load();
        });
        plugin.on('unload', function() {
        
        });
        
        plugin.freezePublicAPI({
            // Compile Solidity text to binary.
            binary: binary
        });
        
        register(null, {
            'ethergit.solidity.compiler': plugin
        });
    }
});