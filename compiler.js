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
    
    function binaryAndABI(sources, dir, cb) {
      async.waterfall([
        getDependencies.bind(null, sources, dir),
        compile
      ], cb);
      
      function compile(sources, cb) {
        solc(
          sources.concat(['--combined-json', 'bin,abi,srcmap,srcmap-runtime,ast']),
          dir,
          function(err, output, warnings) {
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
                {
                  warnings: warnings.length == 0 ? null : warnings,
                  contracts: _.map(compiled.contracts, function(contract, name) {
                    return {
                      name: name,
                      binary: contract.bin,
                      abi: JSON.parse(contract.abi),
                      root: dir,
                      sources: sources,
                      ast: compiled.sources,
                      srcmap: contract['srcmap'],
                      srcmapRuntime: contract['srcmap-runtime'],
                      sourceList: _.map(compiled.sourceList, function(source) {
                        return '/root/workspace' + dir + source;
                      })
                    };
                  })
                }
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
                  // solc <= 0.2.0
                  _.where(node.children, {
                    name: 'Identifier',
                    attributes: { value: 'abstract' }
                  }).length != 0 ||
                  // solc > 0.2.0
                  _.where(node.children, {
                    name: 'UserDefinedTypeName',
                    attributes: { name: 'abstract' }
                  }).length != 0;
              }
            }
          }
        );
      }
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

    function getDependencies(files, dir, cb) {
      var dependencies = [];
      getDeps(files, dependencies, _.partial(cb, _, dependencies));

      function getDeps(files, dependencies, cb) {
        async.eachSeries(files, function(file, cb) {
          if (_.startsWith(file, './')) file = file.substr(2);
          
          if (_.includes(dependencies, file)) return cb();

          dependencies.push(file);
          
          fs.readFile(dir + file, function(err, content) {
            if (err) return cb(err);
            var rx = /^(?:\s*import\s*")([^"]*)"/gm,
                match,
                deps = [];
            while ((match = rx.exec(content)) !== null) {
              deps.push(match[1]);
            }
            getDeps(deps, dependencies, cb);
          });
        }, cb);
      }
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
