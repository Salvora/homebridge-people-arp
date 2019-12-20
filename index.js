var ping = require('ping');
var arp = require('arp-a-x');
var moment = require('moment');
var FakeGatoHistoryService;

var Service, Characteristic, HomebridgeAPI;
module.exports = function(homebridge) {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    HomebridgeAPI = homebridge;
    FakeGatoHistoryService = require('fakegato-history')(homebridge);

    homebridge.registerPlatform("homebridge-people", "PeopleARP", PeoplePlatform);
    homebridge.registerAccessory("homebridge-people", "PeopleAccessory", PeopleAccessory);
}

// #######################
// PeoplePlatform
// #######################

function PeoplePlatform(log, config){
    this.log = log;
    this.threshold = config['threshold'] || 3;
    this.cacheDirectory = config["cacheDirectory"] || HomebridgeAPI.user.persistPath();
    this.checkInterval = config["checkInterval"] || 10000;
    this.people = config['people'];
    this.storage = require('node-persist');
    this.storage.initSync({dir:this.cacheDirectory});
}

PeoplePlatform.prototype = {

    accessories: function(callback) {
        this.accessories = [];
        this.peopleAccessories = [];
        for(var i = 0; i < this.people.length; i++){
            var peopleAccessory = new PeopleAccessory(this.log, this.people[i], this);
            this.accessories.push(peopleAccessory);
            this.peopleAccessories.push(peopleAccessory);
        }
        callback(this.accessories);
    }
}

// #######################
// PeopleAccessory
// #######################

function PeopleAccessory(log, config, platform) {
    this.log = log;
    this.name = config['name'];
    this.target = config['target'];
    this.macAddress = config['macAddress'];
    this.platform = platform;
    this.threshold = config['threshold'] || this.platform.threshold;
    this.checkInterval = config['checkInterval'] || this.platform.checkInterval;
    this.isDoorClosed = true;
    this.timesOpened = 0;

    class LastActivationCharacteristic extends Characteristic {
        constructor(accessory) {
            super('LastActivation', 'E863F11A-079E-48FF-8F27-9C2605A29F52');
            this.setProps({
                format: Characteristic.Formats.UINT32,
                unit: Characteristic.Units.SECONDS,
                perms: [
                    Characteristic.Perms.READ,
                    Characteristic.Perms.NOTIFY
                ]
            });
        }
    }

    this.service = new Service.ContactSensor(this.name);
    this.service
        .getCharacteristic(Characteristic.ContactSensorState)
        .on('get', this.getState.bind(this));

    this.service.addCharacteristic(LastActivationCharacteristic);
    this.service
        .getCharacteristic(LastActivationCharacteristic)
        .on('get', this.getLastActivation.bind(this));

    this.accessoryService = new Service.AccessoryInformation;
    this.accessoryService
        .setCharacteristic(Characteristic.Name, this.name)
        .setCharacteristic(Characteristic.SerialNumber, "hps-"+this.name.toLowerCase())
        .setCharacteristic(Characteristic.Manufacturer, "Elgato");

    this.historyService = new FakeGatoHistoryService("door", {
            displayName: this.name,
            log: this.log
        },
        {
            storage: 'fs',
            disableTimer: true
        });

    this.setDefaults();

    if(this.checkInterval >= 10000) {
        this.arp();
    }
}

PeopleAccessory.encodeState = function(state) {
    if (state) {
        return Characteristic.ContactSensorState.CONTACT_DETECTED;
    } else {
        return Characteristic.ContactSensorState.CONTACT_NOT_DETECTED;
    }
}

PeopleAccessory.prototype.getState = function(callback) {
    callback(null, PeopleAccessory.encodeState(this.isDoorClosed));
}

PeopleAccessory.prototype.getLastActivation = function(callback) {
    var lastSeenUnix = this.platform.storage.getItemSync('lastConnectionLoss_' + this.target);
    if (lastSeenUnix) {
        var lastSeenMoment = moment(lastSeenUnix).unix();
        callback(null, lastSeenMoment - this.historyService.getInitialTime());
    }
}

PeopleAccessory.prototype.identify = function(callback) {
    this.log("Identify: %s", this.name);
    callback();
}

PeopleAccessory.prototype.setDefaults = function() {
    this.service.getCharacteristic(Characteristic.ContactSensorState).updateValue(PeopleAccessory.encodeState(this.isDoorClosed));
}

PeopleAccessory.prototype.arp = function() {
    var newState = true;
    ping.sys.probe(this.target, function(state){
        arp.table(function(error, entry) {
            if(error) {
                this.log('ARP Error: %s', error.message);
            } else {
                if(entry) {
                    if (entry.mac == this.macAddress.toLowerCase()) {
                        if(entry.flag == "0x0") {
                            newState = false;
                            this.platform.storage.setItemSync('lastConnectionLoss_' + this.target, Date.now());
                        }
                        this.setNewState(newState);
                        setTimeout(PeopleAccessory.prototype.arp.bind(this), this.checkInterval);
                    }
                }
            }
        }.bind(this));
    }.bind(this));
}

PeopleAccessory.prototype.setNewState = function(newState) {
    var oldState = this.isDoorClosed;
    if (oldState != newState) {
        this.isDoorClosed = newState;
        this.service.getCharacteristic(Characteristic.ContactSensorState).updateValue(PeopleAccessory.encodeState(newState));

        this.historyService.addEntry(
            {
                time: moment().unix(),
                status: (newState) ? 0 : 1
            });
        this.log('Changed Contact sensor state for %s to %s.', this.target, newState);
    }
}

PeopleAccessory.prototype.getServices = function() {

    var servicesList = [this.service];

    if(this.historyService) {
        servicesList.push(this.historyService)
    }
    if(this.accessoryService) {
        servicesList.push(this.accessoryService)
    }

    return servicesList;

}