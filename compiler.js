define(function(require, exports, module) {
    main.consumes = ['Plugin', 'proc', 'settings', 'preferences', 'dialog.error', 'c9', 'ethergit.libs'];
    main.provides = ['ethergit.solidity.compiler'];
    
    return main;

    function main(options, imports, register) {
        var Plugin = imports.Plugin;
        var proc = imports.proc;
        var settings = imports.settings;
        var prefs = imports.preferences;
        var errorDialog = imports['dialog.error'];
        var c9 = imports.c9;
        var libs = imports['ethergit.libs'];

        var _ = libs.lodash();
        
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

        function solcWithInput(args, input, cb) {
            var solcBin = settings.get('user/ethergit-solidity-compiler/@solc');
            proc.spawn(
                solcBin,
                { args: args },
                function(err, process) {
                    if (err) return cb({ type: 'SYSTEM', message: err });

                    if (!process.pid) {
                        return cb({
                            type: 'SYSTEM',
                            message: 'Could not find ' + solcBin + '. Please, specify a path to Solidity compiler in the preferences.'
                        });
                    }

                    var errorRead = false;
                    var error = '';
                    process.stderr.on('data', function(chunk) {
                        error += chunk;
                    });
                    process.stderr.on('end', function() {
                        errorRead = true;
                        done();
                    });

                    var outputRead = false;
                    var output = '';
                    process.stdout.on('data', function(chunk) {
                        output += chunk;
                    });
                    process.stdout.on('end', function() {
                        outputRead = true;
                        done();
                    });
                    
                    process.stdin.end(input);
                    
                    function done() {
                        if (!outputRead || !errorRead) return;
                        
                        if (error) cb({ type: 'SYNTAX', message: error });
                        else cb(null, output);
                    }
                }
            );
        }
        
        function solc(args, cb) {
            var solcBin = settings.get('user/ethergit-solidity-compiler/@solc');
            proc.execFile(
                solcBin,
                {
                    args: args,
                    cwd: c9.workspaceDir
                },
                function(err, stdout, stderr) {
                    if (err) {
                        if (err.code === 'ENOENT') {
                            cb({
                                type: 'SYSTEM',
                                message: 'Could not find ' + solcBin + '. Please, specify a path to Solidity compiler in the preferences.'
                            });
                        } else if (err.message.indexOf('Command failed: solc') !== -1) {
                            var info = err.message.match(/\.([^: ]+):(\d+):(\d+):/);
                            cb({
                                type: 'SYNTAX',
                                message: err.message.substr(err.message.indexOf('\n') + 1),
                                file: info[1],
                                line: info[2],
                                column: info[3]
                            });
                        } else {
                            cb({
                                type: 'UNKNOWN',
                                message: err.message
                            });
                        }
                    } else if (stderr.length !== 0) {
                        cb({ type: 'SYSTEM', message: stderr });
                    } else cb(null, stdout, stderr);
                }
            );
        }
        
        function binaryAndABI(sources, cb) {
            solc(
                sources.concat(['--combined-json', 'binary,json-abi,ast']),
                function(err, output) {
                    if (err) return cb(err);

                    try {
                        var compiled = JSON.parse(output);
                    } catch (e) {
                        console.error(e);
                        return cb('Could not parse solc output: ' + e.message);
                    }

                    try {
                        cb(
                            null,
                            findNotAbstractContracts(compiled.sources)
                                .map(function(name) {
                                    return {
                                        name: name,
                                        binary: compiled.contracts[name].binary,
                                        abi: JSON.parse(compiled.contracts[name]['json-abi'])
                                    };
                                })
                        );
                    } catch (e) {
                        console.error(e);
                        return cb('Could not parse contract abi: ' + e.message);
                    }

                    function findNotAbstractContracts(sources) {
                        return _(sources).map(function(source) {
                            return _(extractContracts(source.AST))
                                .where({ abstract: false })
                                .map('name')
                                .value();
                        }).flatten().value();
                        
                        function extractContracts(node) {
                            var contracts = _(node.children)
                                    .map(extractContracts)
                                    .flatten()
                                    .value();
                            if (node.name === 'Contract') {
                                contracts.push({
                                    name: node.attributes.name,
                                    abstract: isAbstract(node)
                                });
                            }
                            return contracts;
                        }
                        
                        function isAbstract(node) {
                            return node.attributes.name === 'abstract' ||
                                _.where(node.children, {
                                    name: 'Identifier',
                                    attributes: { value: 'abstract' }
                                }).length != 0;
                        }
                    }
                }
            );
        }
        
        function getAST(text, cb) {
            solcWithInput(['--ast-json', 'stdout'], text, function(err, output) {
                if (err) {
                    if (err.type === 'SYNTAX' || err.type === 'SYSTEM') {
                        //errorDialog.show("Parsing error occurred, double check file syntax please.");
                        cb(err);
                    } else {
                        console.error('Unknown error: ' + err);
                        errorDialog.show('Unknown error occured. See details in devtools.');
                    }
                    return;
                }

                var match = output.split(/=======.*=======/);

                cb(null, {
                    ast : JSON.parse(match[1])
                });
            });
        }

        plugin.on('load', function() {
            load();
        });
        plugin.on('unload', function() {
        
        });
        
        plugin.freezePublicAPI({
            // Compile Solidity text to binary.
            binaryAndABI: binaryAndABI,
	    getAST: getAST
        });
        
        register(null, {
            'ethergit.solidity.compiler': plugin
        });
    }
});
