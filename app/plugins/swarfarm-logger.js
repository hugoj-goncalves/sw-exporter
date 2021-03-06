const requestLib = require('request');

const SWARFARM_URL = 'https://swarfarm.com/api/v2/';
const pluginName = 'SwarfarmLogger';
let request, acceptedCommands, proxy, apiKey;

const trimApiKey = inputApiObject => {
  // Trims whitespace from input API key. Only works for plain string input.
  if (inputApiObject instanceof Object) {
    // JSON input must be done correctly by the user and is not trimmed.
    return inputApiObject;
  } else {
    return inputApiObject.trim();
  }
};

const apiKeyRegex = RegExp('^[a-z0-9]{40}$'); // Exactly 40 hex characters
const apiKeyIsValid = key => apiKeyRegex.test(key);

const getApiKey = wizardId => {
  if (apiKey instanceof Object) {
    return apiKey[wizardId];
  } else {
    return apiKey;
  }
};

const setRequestAuth = (opts, wizardId) => {
  const token = getApiKey(wizardId);
  if (apiKeyIsValid(token)) {
    opts = Object.assign(opts, {
      headers: {
        Authorization: `Token ${token}`
      }
    });
  } else {
    // Only raise error message if some text is present
    if (token) {
      proxy.log({
        type: 'warning',
        source: 'plugin',
        name: pluginName,
        message: 'Invalid API key. Copy/paste it from SWARFARM profile settings. Logging without API key until it is updated.'
      });
    }
  }

  return opts;
};

const getApiCommands = () => {
  // Get list of commands from server

  proxy.log({
    type: 'debug',
    source: 'plugin',
    name: pluginName,
    message: 'Retrieving list of accepted log types from SWARFARM...'
  });

  request.get('data_logs/', (error, response, body) => {
    if (!error && response.statusCode === 200) {
      acceptedCommands = JSON.parse(body);

      proxy.log({
        type: 'success',
        source: 'plugin',
        name: pluginName,
        message: `Looking for the following commands to log: ${Object.keys(acceptedCommands)
          .filter(cmd => cmd != '__version')
          .join(', ')}`
      });
    } else {
      proxy.log({
        type: 'error',
        source: 'plugin',
        name: pluginName,
        message: `Error while getting commands to log: ${response.statusCode}`
      });
    }
  });
};

const processLog = (req, resp) => {
  const { command, wizard_id } = req;

  if (!acceptedCommands[command]) {
    // Not listening for this API command
    return;
  }

  const req_options = setRequestAuth(
    {
      json: true,
      body: { data: { request: req, response: resp, __version: acceptedCommands.__version } }
    },
    wizard_id
  );

  // Send it
  request.post('data_logs/', req_options, (error, response, body) => {
    if (error) {
      proxy.log({
        type: 'error',
        source: 'plugin',
        name: pluginName,
        message: `Error: ${error.message}`
      });
      return;
    }

    // Log message to proxy window
    if (response.statusCode === 200) {
      proxy.log({
        type: 'success',
        source: 'plugin',
        name: pluginName,
        message: `${command} logged successfully`
      });
    } else {
      if (response.statusCode == 401) {
        proxy.log({
          type: 'error',
          source: 'plugin',
          name: pluginName,
          message: `SWARFARM Authentication failure: ${body.detail}`
        });
      } else {
        proxy.log({
          type: 'error',
          source: 'plugin',
          name: pluginName,
          message: `Error ${response.statusCode}: ${body.detail}`
        });
      }
    }

    // Check if server indicates accepted API commands is out of date
    if (body && body.reinit) {
      getApiCommands();
    }
  });
};

const uploadProfile = (req, resp) => {
  const { command } = req;
  const { wizard_id } = resp;

  if (command === 'HubUserLogin') {
    // Check that API key is filled in
    if (!apiKey) {
      proxy.log({
        type: 'error',
        source: 'plugin',
        name: pluginName,
        message: `Profile upload is enabled, but missing API key. Check ${pluginName} settings.`
      });

      return;
    }

    proxy.log({
      type: 'info',
      source: 'plugin',
      name: pluginName,
      message: 'Uploading profile to SWARFARM...'
    });

    const req_options = setRequestAuth(
      {
        json: true,
        body: resp
      },
      wizard_id
    );

    request.post('profiles/upload/', req_options, (error, response, body) => {
      if (error) {
        proxy.log({
          type: 'error',
          source: 'plugin',
          name: pluginName,
          message: `Error: ${error.message}`
        });
        return;
      }

      if (response.statusCode === 200) {
        proxy.log({
          type: 'debug',
          source: 'plugin',
          name: pluginName,
          message: 'SWARFARM profile successfully uploaded - awaiting import queue.'
        });

        const jobId = body.job_id;
        let resultCheckTimer;

        // 5 minute failsafe to stop checking job status
        const failsafeCheckTimer = setTimeout(() => {
          proxy.log({
            type: 'error',
            source: 'plugin',
            name: pluginName,
            message: 'Timed out retrieving import status.'
          });
          clearInterval(resultCheckTimer);
        }, 300000);

        resultCheckTimer = setInterval(() => {
          request.get(
            `profiles/upload/${jobId}/`,
            setRequestAuth(
              {
                json: true
              },
              wizard_id
            ),
            (resultError, resultResponse, resultBody) => {
              if (resultBody && resultBody.status === 'SUCCESS') {
                clearTimeout(failsafeCheckTimer);
                clearInterval(resultCheckTimer);

                proxy.log({
                  type: 'success',
                  source: 'plugin',
                  name: pluginName,
                  message: 'SWARFARM profile import complete!'
                });
              }
            }
          );
        }, 2500);
      } else if (response.statusCode === 400) {
        // HTTP 400 Bad Request - malformed upload data or request
        proxy.log({
          type: 'error',
          source: 'plugin',
          name: pluginName,
          message: `There were errors importing your SWARFARM profile: ${JSON.stringify(body)}`
        });
      } else if (response.statusCode === 401) {
        // HTTP 401 Unauthorized - Failed to authenticate
        proxy.log({
          type: 'error',
          source: 'plugin',
          name: pluginName,
          message: 'Unable to authenticate to SWARFARM. Check your API key in settings.'
        });
      } else if (response.statusCode === 409) {
        // HTTP 409 Conflict - Validation checks failed
        proxy.log({
          type: 'error',
          source: 'plugin',
          name: pluginName,
          message: `${JSON.stringify(body)}. You must manually upload your profile on SWARFARM to resolve this.`
        });
      }
    });
  }
};

module.exports = {
  defaultConfig: {
    enabled: true,
    profileSync: false,
    apiKey: ''
  },
  defaultConfigDetails: {
    profileSync: { label: 'Automatically upload profile to SWARFARM' },
    apiKey: { label: 'SWARFARM API key', type: 'textarea' }
  },
  pluginName,
  pluginDescription: 'Syncs your SWARFARM profile automatically and logs data for your account.',
  init(proxyInstance, config) {
    if (config.Config.Plugins[pluginName].enabled) {
      proxy = proxyInstance;
      request = requestLib.defaults({ baseUrl: SWARFARM_URL });
      config.Config.Plugins[pluginName].apiKey = trimApiKey(config.Config.Plugins[pluginName].apiKey);

      if (!config.Config.Plugins[pluginName].apiKey) {
        if (config.Config.Plugins[pluginName].profileSync) {
          // Error message to user indicating profile sync will not work without API key
          proxy.log({
            type: 'error',
            source: 'plugin',
            name: pluginName,
            message:
              'An API key is required for SWARFARM profile sync and recommended for data logging. Copy it into settings from your SWARFARM Edit Profile page to enable this feature.'
          });
        } else {
          // Warning message to user to prompt to set API key.
          proxy.log({
            type: 'warning',
            source: 'plugin',
            name: pluginName,
            message:
              'You have not configured a SWARFARM API key in Settings. Logs will attempt to be associated to your SWARFARM account via in-game account ID, but this is not guaranteed to work.'
          });
        }
      }

      try {
        getApiCommands();
      } catch (error) {
        proxy.log({
          type: 'error',
          source: 'plugin',
          name: pluginName,
          message: 'Unable to retrieve accepted log types. SWARFARM logging is disabled.'
        });
      }
      setInterval(getApiCommands, 60 * 60 * 1000); // Refresh API commands every hour

      proxy.on('apiCommand', (req, resp) => {
        // Update API key from settings each log event in case it changed
        apiKey = config.Config.Plugins[pluginName].apiKey;

        try {
          processLog(req, resp);
        } catch (error) {
          proxy.log({
            type: 'error',
            source: 'plugin',
            name: pluginName,
            message: 'Error submitting log event to SWARFARM.'
          });
        }

        // Profile sync if enabled
        if (config.Config.Plugins[pluginName].profileSync) {
          uploadProfile(req, resp);
        }
      });
    }
  }
};
