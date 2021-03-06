/*	things to do in this code
	1- keep updating comments as code changes.
*/


/*	==================
	We will perform a GET resquest, for all the busses, to dadosaberto.rio.gov.br

	we have to send a GET request to this url:  
	http://dadosabertos.rio.rj.gov.br/apiTransporte/apresentacao/rest/index.cfm/onibus
	the response will be a json containing the GPS position, and some more information, of every bus

	old url: http://dadosabertos.rio.rj.gov.br/apiTransporte/apresentacao/rest/index.cfm/obterTodasPosicoes
	this old url does not have bus direction on its json response
*/

var winston = require('winston'); // importing library that will help us write better logs.

// function that returns our standart time stamp format. I'm using it for the loggers and for the json's 'lastUpdate'.
function timeStamp () {return (new Date()).toLocaleString()};

/*	creating a custom log writer. It will log on console and in a file. 
	it seems that handling exceptions mean that it will log it and won't abort the code. im not sure. */
var consoleTransportOptions = {
	colorize: true, // color is only visible on command line tool.
	timestamp: timeStamp
};
var fileTransportOptions = { 
	filename: 'dataGrabberLog.log',
	handleExceptions: true,
	colorize: true, // color is only visible on command line tool.
	timestamp: timeStamp,
};
var logger = new (winston.Logger)({ transports: [ new (winston.transports.Console)(consoleTransportOptions),
												  new (winston.transports.File)(fileTransportOptions) ] });

logger.on('error', function (err) { console.log(err) }); // winston logger can produce erros...

var http = require('http'); // importing http module. it's a node's default module.
var fs = require('fs');	// importing filesystem module. using fs to read riobus-config.json.
var zlib = require('zlib'); // importing zlib module that we will use to decompress the JSON compressed in gzip.

// object that represents what happend in the last time we requested for data and how many times this has been repeating.
var lastStatus = {label: 0, // 'label' is the identification of what happened.
				counter: 0} // 'counter' counts it. zero means an unpredicted situation has happened.


// function that will be called when we receive a response from dadosabertos server.
var httpGETCallback = function (response) {

	/*	registering function that will be called if there is an error on response. When response triggers 
		the 'data' event. I don't know which types of error there could be. */
	response.on('error', function (err) {
		logOnGuardsSendLastStatus('warn', "We've had this error on dadosabertos RESPONSE: " + err, err.message, true);
	});

	/*	We are sending a request only an 'intervalTime' after we get a response or, if we don't get one, an 'intervalTime' 
		after our request times out (when timeout, wait for a few seconds and send another request). */
	httpGetIntervalCode = setTimeout(sendRequestAndGrabData, intervalTime);

	if (response.statusCode == 200) { // we can only do stuff if we receive an statusCode of 200 in the http protocol.
		// console.log(' - HEADERS: ' + JSON.stringify(response.headers)); // printing http header from server's response.

		var json = ''; // variable that will hold the json received from dadosabertos server.

		/*	in here we need to check if the response we are getting is compressed with gzip. if it is, we have to
			instantiate a gzip decompresser and tell node to pass all the data from response to this gzip decompresser.
			in the end, we set either object (response or gzip) that will be notified by the .on('data') 
			and .on('end') events. both the response and the gzip decompresser (it seems...) listen to these two events. 
			I don't actually understand this 'pipe' thing. */
		var output; // the object that will listen for 'data' and 'end' events.
		if (response.headers['content-encoding'] == 'gzip') { // the server tell us which kind of thing it is sending.
			var gzip = zlib.createGunzip(); // creating the gzip decompresser.
			response.pipe(gzip); // sending data from the responses (compressed) to the decompresser.
			output = gzip; // the decompresser will listen for 'data' and 'end' events.
		} else {
			output = response; // the response will listen for 'data' and 'end' events.
		}

		/*	registering function that will be called at every chunk received by either the response
			or the decompresser. When the 'data' event is triggered. */
		output.on('data', function (chunk) {
			json += chunk.toString('utf-8'); // appending all the chunks.
		});

		/*	registering function that will be called when data is completely received.
			When the 'end' event is triggered. */
		output.on('end', function () {
			try {
				// parsing all the data, read as a string, as JSON. now, it's a javascript object.
				json = JSON.parse(json);

				/*	If we received a message saying that our request was good but nothing has been found, we
					will not consider it as a valid response. because it means their service could not provide
					any data, which they should. As we are quering for everything, something must be provided. */
				// checking if dadosabertos server gave us just a message telling us that nothing were found.
				// "COLUMNS" attribute change to an array with size 1 and its content is'MENSAGEM'.
				if (json['COLUMNS'][0] === "MENSAGEM") { // we don't care about the messages.
					json = null; // it means this json is invalid to our purpose.
					// it means 'status.Code' is 200, JSON was parsed, but there's only a message in the JSON.
					logOnGuardsSendLastStatus('info', "Dadosabertos said: " + json['DATA'][0][0], 'only message', true);
					// message comes inside 'DATA', nested 2 times.
				}
			} catch (err) {
				json = null; // if there was an error when parsing the json, it is invalid to our purpose.
				if (err instanceof SyntaxError) {
					// it means 'status.Code' is 200 but JSON could not be parsed.
					logOnGuardsSendLastStatus('warn', "We've had a syntax error while parsing json file from dadosabertos", 
									'bad json', true);
				} else {
					logger.error(err.stack);		
				}
			}

			if (json !== null) { // if json is a valid object, keep going.

				// logging notice that we are back on trail. this case means everything went well.
				logOnGuardsSendLastStatus('info', "Dadosabertos is fine. We have just got some data, code: " 
						+ response.statusCode, 'success', false);

				/*	object 'data' is here to represent a data structure. that will hold all the busses 2 times. 
					We will add busses grouped by bus lines and individually. this object will be sent to the server.js 
					thread everytime we can successfully retrieve dadosabertos JSON and parse it. */
				var data = {};

				/*
					'data' will be a hashtable/hashmap, where the keys will be the bus line, in which the value
					will be all the busses on this line that came in the JSON response, and the bus orders, in 
					which the value will be its respective bus, like this:

					key 			: 	value
					"<bus line>"	: 	[<bus info>, <bus info>, ...],
					"<bus line>"	: 	[<bus info>, <bus info>, ...],
					"<bus line>"	: 	[<bus info>, <bus info>, ...],
					"<bus order>"	: 	<bus info>,
					"<bus order>"	: 	<bus info>,
					"<bus order>"	: 	<bus info>

					where :
					<bus info> = ["DATAHORA","ORDEM","LINHA","LATITUDE","LONGITUDE","VELOCIDADE","DIRECAO"]
					<bus line> = "LINHA"
					<bus order> = "ORDEM"

					I have decided to build the structure in this way because I believe this is the way we should build
					our future database. This structre makes the search for all the busses in a bus line, retrieve a
					single value from one key. This is the main operation done in the project: a search for all the busses
					from one bus line. And also, this is the best way to retrieve a bus when we receive a query for a bus
					order. And also beceause the whole 'data' isn't big. Memory ins't an issue by now.
				*/

				// loop running backwards, according to google's recommendation for v8 engine. **forwards is just as good**.
				for (var i = json.DATA.length - 1; i >= 0; i--) {
					var bus = json.DATA[i];
					var key = "" + bus[2]; // string that will be the key for the hashmap structure. 
					// "" + NUMBER, parses the NUMBER to a string. javascript's easiest way to parse number to string.
					if (data[key]){ // if key already exists in data structure.
						data[key].push(bus); // add this bus to this key (add bus to its respective line).
					} else { // if key doesn't exist.
						data[key] = [bus]; // instantiate an array in the key with this bus inside it.
					}

					data[bus[1]] = [bus]; // key is bus order value. value is the whole bus information.
					/*	array inside array, because on retrieval it will come nested, just like when we retrive a bus line.
						when we retrieve a bus line (data[<bus line>]), we also get an array of arrays. */
				}

				/*	printing the amount of busses in each bus line. it doesn't mean that there are this amount of
					in each bus line right now, because the time and date coul be saying that some busses were last
					seen a long time ago.
				*/ 
				// for (key in data){
				// 	console.log(key, "-",data[key].length);
				// }

				// sending 'data', 'json', 'orders' and lastUpdate to parent thread.
				process.send({data: data, json: json, lastUpdate: timeStamp(), lastStatus: lastStatus});
				/*	lastUpdate informs when we received the last successful response. transforming date to a 
					readable UTC time string. it looks like this: "Sun Nov 02 2014 16:26:12 GMT-0200 (BRST)"*/


				/*	this is the part where we should store the data in a database.
					by now, we just print some shit about the response and write a json file with the data organized
					by bus line. */
				// var keys = Object.keys(data); // return all the keys in our simple data structure
				// console.log(keys); // print all keys
				// console.log(" --- Number of bus lines = " + keys.length); // print the amount of keys

				/*
					writing a JSON file containing everything that is inside our data.
					- JSON.stringify(data) turns the object into string as JSON format.
					- JSON.stringify(data, null, 4) writes a JSON string with new lines 
					after commas (",") and with a paragraph size of 4 spaces
				*/
				// fs.writeFile('dataGrabbed.json', JSON.stringify(data), function (err) {
				// 	if (err) 
				// 		throw err;
				// 	console.log('It\'s saved!');
				// });
			}
		});
	} else { // if response's statusCode wasn't 200, than it's bad new.
		/*	writing an specific log message for each status code returned by dadosabertos but only if it's not
			the same as the one we got in the previous response. I don't want to log the same thing over and over. */
		if (response.statusCode == 503) {
			logOnGuardsSendLastStatus('warn',"Dadosabertos server was unavailable, code: " + response.statusCode, 
											response.statusCode, true);
		} else if (response.statusCode == 404) { // 404 not found.
			logOnGuardsSendLastStatus('warn', "Dadosabertos server could not find anything matching the url, code: " 
					+ response.statusCode, response.statusCode, true);
		} else if (response.statusCode == 302) {
			logOnGuardsSendLastStatus('warn', "Dadosabertos wants us to redirect our request to a new url, code: " 
					+ response.statusCode, response.statusCode, true);
		} else {
			logOnGuardsSendLastStatus('warn', "Dadosabertos responded with statuscode: " + response.statusCode, 
											response.statusCode, true);
		}
	}
}

var intervalTime; // default intervalTime to be passed as argument in the setTimeout function later on.
var httpGetIntervalCode; //variable that will hold the 'setTimeout([function], time)' return identifier.

// saved the function that sends the request in this variable, just so I can use it again inside setTimeout().
function sendRequestAndGrabData() {

	/* getting the configuration of this request from a JSON file. this will help us change the server address and
		not stop the execution. we also get the intervalTime from this file.
		I'm making a syncronous read because this file is pretty is small, so it opens fast. */
	// reading JSON configuration file
	var config = JSON.parse(fs.readFileSync(__dirname + "/riobus-config.json")).dataGrabber;
	intervalTime = config.intervalTime; // intervalTime comes from the JSON configuration file.

	// setting the minimum request information that will be needed to use on http.get() function
	var options = {
		host: config.host, // comes from JSON configuration file
		path: config.path, // comes from JSON configuration file
		agent: false, // agent keeps connection alive until response. we turn it off so there's nothing keeping it alive.
		headers: { // we want to get the data enconded with gzip, after lots of trial and error, this is the right order
	  		"Accept-Encoding": "gzip", // we first say it has to be compacted with gzip
			"Accept": "application/json" // then we say which format we want to receive
		} // the other header parameters seems to be useless (i could be wrong)
	};

	/*
		http.get(options, [callback]) function makes a request using method GET and calls request.end() automatically.
		I don't think we need to keep the connection alive and we don't need a body. that's why I decided for http.get()
		instead of http.request() */
	// SENDING REQUEST RIGHT NOW. this is when things actually start. the rest of the code above is still to be run.
	var requestGet = http.get(options, httpGETCallback);

	/*	setting a callback function that runs when our request's times out. when the request times out, the connection 
		is still up. It's nothing more than a simple javsascript 'setTimeout()' scheduler underneath this call. */
	requestGet.setTimeout(config.timeout, function () {
		logOnGuardsSendLastStatus('warn', 'Our REQUEST has timed out.', 'timeout', true);
		requestGet.abort(); // this makes the request emit an 'error' event. because it force closes the current connection.
	})

	// registering function that will be called if our request triggers an 'error' event.
	requestGet.on('error', function (e) {
		if (lastStatus.label !== 'timeout') { // checking if our last request has timed out.
			// setting a different log for each known error code.
			if (e.code === 'ENOTFOUND') {
				logOnGuardsSendLastStatus('warn', "We couldn't find dadosabertos address, code: " + e.code, 
												e.code, true);
			} else if (e.code === 'ECONNRESET') {
				logOnGuardsSendLastStatus('warn', "Dadosabertos server closed the connection on us, code: " + e.code, 
												e.code, true);
			} else if (e.code === 'ECONNREFUSED') {
				logOnGuardsSendLastStatus('warn', "Dadosabertos server is off, code: " + e.code, e.code, true);
			} else { // case where error code is new to me.
				logOnGuardsSendLastStatus('warn', 'Our REQUEST has had this error: ' + e.message + " - " + e.code,
												e.code, true);
			}
		}
		httpGetIntervalCode = setTimeout(sendRequestAndGrabData, intervalTime); // on errors, resend request after interval.
		// calling 'clearInterval(httpGetIntervalCode)' stops the scheduled function corresponding to 'httpGetIntervalCode'.
	});

}

sendRequestAndGrabData(); // calling the code that sends the request.

/*	function that loggs 'logMessage' under 'logLevel' if 'lastStatus.lable' isn't the same as current status. Current 
	status is the 'label' provided. It also counts how many times a 'label' is seen. In the end, it may pass 'lastStatus'
	to parent thread according to 'sendLastStatus' boolean value. */
function logOnGuardsSendLastStatus(logLevel, logMessage, label, sendLastStatus) {
	if (lastStatus.label !== label) { // last response we weren't in the 'label' case.
		logger.log(logLevel, logMessage); // so we will log the current case with 'logMessage', using 'logLevel'.
		lastStatus.label = label; // setting the label of the current situation. so it will be used in the next request.
		lastStatus.counter = 1; // it's the first time this label is set. because of the IF() expression.
	} else lastStatus.counter++; // if the 'lastStatus' is the same as the 'label', we are on the same case again.
	if (sendLastStatus) process.send({lastStatus: lastStatus}); // if we need to pass just the 'lastStatus', pass it.
}