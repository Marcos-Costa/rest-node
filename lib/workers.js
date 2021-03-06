/*
* Worker-related tasks
*/

// Dependecies
const path = require('path');
const fs = require('fs');
const _data = require('./data');
const https = require('https');
const http = require('http');
const helpers = require('./helpers');
const url = require('url');
const _logs = require('./logs');
const util = require('util');
const debug = util.debuglog('workers');

// Instantiate the worker object
const workers = {};

// lookup all checks, get their data, send to a validator
workers.gather_all_checks = () =>{
  // Get all the checks
  _data.list('checks', (err,checks)=>{
    if(!err && checks && checks.length > 0){
      checks.forEach((check)=>{
        // Read in the check data
        _data.read('checks', check, (err,original_check_data)=>{
          if(!err && original_check_data){
            // Pass it to the check validator, and let that function continue
            // or log error that exist
            workers.validate_check_data(original_check_data);
          }else{
            debug("Error reading one of the check's data");
          }
        });
      });
    }else{
      debug("Error: Could not find any checks to process");
    }
  });
};

// Sanity-check the check-data
workers.validate_check_data = (original_check_data)=>{
  original_check_data = typeof(original_check_data) == 'object' && original_check_data != null ? original_check_data : {};
  original_check_data.id = typeof(original_check_data.id) == 'string'  && original_check_data.id.trim().length == 20 ? original_check_data.id : false;

  original_check_data.user_phone = typeof(original_check_data.user_phone) == 'string'  && original_check_data.user_phone.trim().length >= 8 ? original_check_data.user_phone : false;
  original_check_data.protocol = typeof(original_check_data.protocol) == 'string'  && ['http','https'].indexOf(original_check_data.protocol) > -1 ? original_check_data.protocol : false;
  original_check_data.url = typeof(original_check_data.url) == 'string' && original_check_data.url.trim().length > 0 ? original_check_data.url.trim() : false;
  original_check_data.method = typeof(original_check_data.method) == 'string' && ['post', 'get', 'put', 'delete'].indexOf(original_check_data.method) > -1 ? original_check_data.method : false;
  original_check_data.success_codes = typeof(original_check_data.success_codes) == 'object' &&  original_check_data.success_codes instanceof Array && original_check_data.success_codes.length > 0 ? original_check_data.success_codes : false;
  original_check_data.timeout_seconds = typeof(original_check_data.timeout_seconds) == 'number' && original_check_data.timeout_seconds % 1 == 0 && original_check_data.timeout_seconds >= 1 && original_check_data.timeout_seconds <= 5 ? original_check_data.timeout_seconds : false;

  // Set the keys that may note be set (if the workers have never seen this check before)
  original_check_data.state = typeof(original_check_data.state) == 'string'  && ['up','down'].indexOf(original_check_data.state) > -1 ? original_check_data.state : 'down';
  original_check_data.last_check = typeof(original_check_data.last_check) == 'number' && original_check_data.last_check > 0  ? original_check_data.last_check : false;

  // If all the checks pass, pass the data along to the next step in the process
  if(original_check_data.id &&
    original_check_data.user_phone &&
    original_check_data.protocol &&
    original_check_data.url &&
    original_check_data.method &&
    original_check_data.success_codes &&
    original_check_data.timeout_seconds){

    workers.perform_check(original_check_data);
  }else{
    debug("Error: one of the checks is not properly formatted, Skipping it.")
  }
};

// Peform the check, send the original_check_data and outcome the check process to the next step in the process
workers.perform_check = (original_check_data)=>{
  // Prepare the initial check outcome
  let check_outcome = {
      'error' : false,
      'responseCode' : false
  };
  // Mark that the outcome has not been sent yet
  let outcome_sent = false;

  // Parse the hostname and the path out of the original check data
  const parsed_url = url.parse(original_check_data.protocol+'://'+original_check_data.url, true);
  const host_name = parsed_url.hostname;
  const path = parsed_url.path; // Using path and not "pathname" because we want the query string

  // Construct the Request
  const request_details = {
    'protocol'  : original_check_data.protocol+':',
    'hostname'  : host_name,
    'method'    : original_check_data.method.toUpperCase(),
    'path'      : path,
    'timeout'   : original_check_data.timeout_seconds * 1000
  };

  // Instantiate the request object (using either the http or https module)
  const _moduleToUse = original_check_data.protocol == 'http' ? http : https;
  let request = _moduleToUse.request(request_details, (response)=>{
    // Grab the status of the sent request
    const status = response.statusCode;

    // Update the check outcome and pass the data along
    check_outcome.responseCode = status;

    if(!outcome_sent){
      workers.process_check_outcome(original_check_data, check_outcome);
      outcome_sent = true;
    }
  });

  // Bind to the error event so it doesn't get thrown
  request.on('error', (e)=>{
    // Update the check outcome and pass the data along
    check_outcome.error = {
      'error' : true,
      'value' : e
    };
    if(!outcome_sent){
      workers.process_check_outcome(original_check_data, check_outcome);
      outcome_sent = true;
    }
  });

  // Bind to the timeout event
  request.on('timeout', (e)=>{
    // Update the check outcome and pass the data along
    check_outcome.error = {
      'error' : true,
      'value' : 'timeout'
    };
    if(!outcome_sent){
      workers.process_check_outcome(original_check_data, check_outcome);
      outcome_sent = true;
    }
  });

  // End the request
  request.end();
};

// Process the check outcome, update the check data as needed, trigger alert to
// user if needed. Special logic for accomodating a check that has never been
// tested before.
workers.process_check_outcome = (original_check_data, check_outcome)=>{

  // Decide if the check is considered up or down
  const state = !check_outcome.err && check_outcome.responseCode && original_check_data.success_codes.indexOf(check_outcome.responseCode) > -1 ? 'up' : 'down';

  // Decide if an aler is warranted
  const alert_warranted = original_check_data.last_check && original_check_data.state != state ? true : false;

  // Log the outcome
  let time_of_check = Date.now();
  workers.log(original_check_data, check_outcome, state,alert_warranted,time_of_check);

  // Update the check data
  const new_check_data = original_check_data;
  new_check_data.state =  state;
  new_check_data.last_check = time_of_check;

  // Save the updates
  _data.update('checks', new_check_data.id, new_check_data, (err)=>{
    if(!err){
      // Send he new check data to the next phase in the process if needed
        if(alert_warranted){
          workers.alert_user_to_status_change(new_check_data);
        }else{
          debug('check outcome has not changed, no alert needed.');
        }
    }else{
      debug("Error trying to save updates to one of the checks");
    }
  });
};

// Alert the user as to a change in their check status
workers.alert_user_to_status_change = (new_check_data)=>{
  const msg = 'Alert: Your check for' + new_check_data.method.toUpperCase()+' '+new_check_data.protocol+'://'+new_check_data.url+' is currently '+ new_check_data.state;
  helpers.send_twilio_sms(new_check_data.user_phone, msg, (err)=>{
    if(!err){
      debug("Sucess: User was alerted to a status change in their check, via sms.")
    }else{
      debug("Error: could not send sms alert to user who had a state change in their check.");
      }
    });
};

workers.log = (original_check_data, check_outcome, state,alert_warranted,time_of_check) =>{
  const log_data = {
    'check' : original_check_data,
    'outcome' : check_outcome,
    'state' : state,
    'alert' : alert_warranted,
    'time' : time_of_check
  };

  // Convert data to a string
  const log_string = JSON.stringify(log_data);

  // Determine the name of the log file
  const log_file_name = original_check_data.id;

  // Append the log string to the file
  _logs.append(log_file_name, log_string,(err)=>{
    if(!err){
      debug("Loggin to file succeded");
    }else{
      debug("Loggin to file failed");
    }
  });
};
// Timer to execute the worker-process once per minute
workers.loop = ()=>{
  setInterval(()=>{
    workers.gather_all_checks();
  }, 1000 * 60)
};

// Rotate (a.k.a compress) the log files
workers.rotate_logs = () =>{

  // List all the (nono compressed) log files
  _logs.list(false, (err,logs)=>{
    if(!err && logs && logs.length > 0){
      logs.forEach((log_name)=>{
        // Compress the data to a different file
        const log_id = log_name.replace('.log','');
        const new_file_id = log_id+'-'+Date.now();
        _logs.compress(log_id, new_file_id, (err)=>{
          if(!err){
            // Truncate the log
            _logs.truncate(log_id,(err)=>{
              if(!err){
                debug("Success trucanting log file");
              }else{
                debug("Error truncating log file");
              }
            });
          }else{
            debug("Error compressing one of the log files", err);
          }
        });
      });
    }else{
      debug("Error: could not find any logs to rotate");
    }
  });
};

// Timer to execute log rotation process once per day
workers.log_rotation_loop =()=>{
  setInterval(()=>{
    workers.rotate_logs();
  }, 1000 * 60 * 60 * 24)
};

// Init script
workers.init = ()=>{

  // Send to console, in yellow
  console.log('\x1b[33m%s\x1b[0m','Background workers are running');

  // Execute all the checks immediately
  workers.gather_all_checks();

  // Call the loop so the checks wil execute later
  workers.loop();

  // Compress all the logs immediately
  workers.rotate_logs();

  // Call the compression loop so logs will be compressed later on
  workers.log_rotation_loop();
};

// Export the module
module.exports = workers;
