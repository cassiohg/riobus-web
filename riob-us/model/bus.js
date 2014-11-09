var mongoose     = require('mongoose'); // Mongoose uses models to storage data into MongoDB
var Schema       = mongoose.Schema; // Schema is used to set model structure

// Bus model: last_update and data
var BusSchema   = new Schema({
	last_update: String,
	data: String
});

// Associates Bus to BusSchema
module.exports = mongoose.model('Bus', BusSchema);