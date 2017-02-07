define(function(require, exports, module) {
  main.consumes = [
    'Plugin', 'proc', 'settings', 'preferences', 'dialog.error', 'c9', 'fs',
    'ethergit.libs'
  ];
  main.provides = ['ethergit.solidity.compiler'];
  return main;

  function main(options, imports, register) {
    this.version = JSON.parse(require('text!./package.json')).version;
    
    var Plugin = imports.Plugin;
    var proc = imports.proc;
    var settings = imports.settings;
    var prefs = imports.preferences;
    var errorDialog = imports['dialog.error'];
    var c9 = imports.c9;
    var fs = imports.fs;
    var libs = imports['ethergit.libs'];

    var async = require('async');
    
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
    
    function solc(args, dir, cb) {
      var solcBin = settings.get('user/ethergit-solidity-compiler/@solc');
      proc.execFile(
        solcBin,
        {
          args: args,
          cwd: c9.workspaceDir + dir,
          maxBuffer: 1024 * 1024
        },
        function(err, stdout, stderr) {
          if (err) {
            if (err.code === 'ENOENT') {
              cb({
                type: 'SYSTEM',
                message: 'Could not find ' + solcBin + '. Please, specify a path to Solidity compiler in the preferences.'
              });
            } else if (err.message.indexOf('Command failed: ') !== -1) {
              var info = err.message.match(/^([^: ]+):(\d+):(\d+):/m);
              if (!info) cb({ type: 'SYSTEM', message: err.message });
              else {
                var file = _.startsWith(info[1], './') ?
                      info[1].substr(1) : '/' + info[1];
                cb({
                  type: 'SYNTAX',
                  message: err.message.substr(err.message.indexOf('\n') + 1),
                  file: info[1],
                  line: info[2],
                  column: info[3]
                });
              }
            } else {
              cb({
                type: 'UNKNOWN',
                message: err.message
              });
            }
          } else cb(null, stdout, stderr);
        }
      );
    }
    
    function binaryAndABI(sources, dir, withDebug, cb) {
      var options = withDebug ?
            ['--combined-json', 'bin,abi,srcmap,srcmap-runtime,ast'] :
            ['--optimize', '--combined-json', 'bin,abi,ast'];
      solc(
        sources.concat(options),
        dir,
        function(err, output, warnings) {
          if (err) return cb(err);

          try {
            var compiled = JSON.parse(output);
          } catch (e) {
            console.error(e);
            return cb('Could not parse solc output: ' + e.message);
          }

          var contracts = _.map(compiled.contracts, function(contract, name) {
            return {
              name: name.substr(name.indexOf(':') + 1),
              binary: contract.bin,
              abi: JSON.parse(contract.abi),
              root: c9.workspaceDir + dir,
              sourceList: compiled.sourceList,
              ast: compiled.sources,
              srcmap: contract['srcmap'],
              srcmapRuntime: contract['srcmap-runtime']
            };
          });
          
          try {
            cb(
              null,
              {
                warnings: warnings.length == 0 ? null : warnings,
                contracts: contracts
              }
            );
          } catch (e) {
            console.error(e);
            return cb('Could not parse contract abi: ' + e.message);
          }
        }
      );
    }
    
    function getAST(text, cb) {
      solcWithInput(['--combined-json', 'ast'], text, function(err, output) {
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

        cb(null, {
          ast : JSON.parse(output).sources['<stdin>'].AST
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
