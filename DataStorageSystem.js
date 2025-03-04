import { system, MolangVariableMap, world } from '@minecraft/server';
/**
 * Storage System for Complex Data Types in Minecraft PE Dynamic Properties
 *
 * This module provides functionality to recursively save and load complex objects
 * into Minecraft PE's dynamic properties storage. It includes support for:
 *  - Recursively saving object properties (excluding functions and certain ignored properties)
 *  - Abbreviating property names to reduce memory consumption
 *  - Customized saving/loading for specific types (e.g. type "V" for vector objects)
 *  - Maintaining a class registry to restore class instances (including their methods)
 *
 * Future improvements might include the development of storage references:
 * a set of all stored/loaded complex objects could be maintained to check whether
 * an object is already present, and if so, use a reference instead of duplicating it.
 */

/**
 * Registry for class constructors.
 *
 * This registry maps a type identifier to its corresponding class. During loading,
 * the registry is used to instantiate the correct class, ensuring that both properties
 * and functions (methods) are restored. Each instance must have a "type" property.
 */
export let KlassenRegistry = null;

/**
 * Initializes the KlassenRegistry with a mapping from type strings to class constructors.
 * Ensure that any class you wish to restore is included here.
 */
export function initializeClasses() {
    KlassenRegistry = {
        'ClassTypeProperty': Class
    };
}

/**
 * Set of properties to ignore during the save process.
 * These properties (e.g. blocksMap, destroyedMap, outlineBlocks) are excluded
 * from storage to avoid unnecessary data or circular references.
 */
const ignoreProperties = new Set([]);

/**
 * Set of types that require a customized storage system.
 * Objects of these types are handled individually, bypassing the default algorithm.
 */
const typesWithCostumizedStorageSystem = new Set(["Array"]);

/**
 * Map for abbreviating property keys during saving.
 * This reduces the overall memory consumption by replacing longer property names
 * with their abbreviated equivalents.
 */
const abbreviationsMap = new Map([
    ['Property', 'Abbreviation']
]);

/**
 * Map for expanding abbreviated property keys during loading.
 * This restores the original property names from their abbreviated forms.
 */
const abbreviationsLoad = new Map([
    ['Abbreviation', 'Property']
]);

/**
 * Class responsible for saving instances to the dynamic property storage.
 */
export class Save {
    /**
     * Recursively saves an instance to the dynamic property storage.
     *
     * @param {*} instance - The object or value to be saved.
     * @param {string} saveKey - The base key under which the instance is stored.
     * @param {*} storageDest - The storage destination (defaults to `world`).
     * @param {number} operations - The recursion depth (used internally for debugging).
     * @param {boolean} costumizedSaveAllowed - used internally to avoid infinite loop
     * @throws {Error} If the provided instance is null.
     */
    static saveInstance(instance, saveKey, storageDest = world, operations = 0, costumizedSaveAllowed = true) {
        if (instance == null) throw new Error("Instance was null, saveKey: " + saveKey);
        const keys = this.getKeys(instance);
        // If the instance has no properties to save or is a primitive/string, store it directly.
        if (keys.length == 0 && !Array.isArray(instance) || (typeof instance === "string" || instance instanceof String)) {
            storageDest.setDynamicProperty(`${saveKey}`, instance);
        } else {
            // Mark arrays with a type indicator.
            if (Array.isArray(instance)) {
                instance.type = "Array";
            }
            // If the instance requires a customized save, use the special handler.
            if (instance.type && typesWithCostumizedStorageSystem.has(instance.type) && costumizedSaveAllowed) {
                this.costumizedSave(instance, saveKey, storageDest);
            } else {
                // Save the list of keys (using abbreviations if available) for later retrieval.
                storageDest.setDynamicProperty(`${saveKey}keys`, keys.map(k => abbreviationsMap.has(k) ? abbreviationsMap.get(k) : k).join(","));
                // Recursively save each property.
                keys.forEach(key => {
                    const prop = instance[key];
                    let saveKeyAbbreviated = abbreviationsMap.has(key) ? abbreviationsMap.get(key) : key;
                    Save.saveInstance(prop, `${saveKey}${saveKeyAbbreviated}`, storageDest, ++operations);
                });
            }
        }
    }

    /**
     * Saves instances that require a customized storage process.
     *
     * @param {*} instance - The object to be saved.
     * @param {string} key - The base key for storage.
     * @param {*} storageDest - The storage destination.
     */
    static costumizedSave(instance, saveKey, storageDest) {
        switch (instance.type) {
            case "Array":
                const keysToSave = ["length", "type"];
                storageDest.setDynamicProperty(`${saveKey}keys`, keysToSave.map(k => abbreviationsMap.has(k) ? abbreviationsMap.get(k) : k).join(","));
                const keys = this.getKeys(instance);
                keys.forEach(key => {
                    const prop = instance[key];
                    let saveKeyAbbreviated = abbreviationsMap.has(key) ? abbreviationsMap.get(key) : key;
                    Save.saveInstance(prop, `${saveKey}${saveKeyAbbreviated}`, storageDest, 0);
                });
                break;
            default:
                // Fallback to the default save mechanism.
                this.saveInstance(instance, saveKey, storageDest, 0, false);
                break;
        }
    }

    /**
     * Retrieves property names from an instance that should be saved.
     * Filters out functions and properties defined in ignoreProperties.
     *
     * @param {*} instance - The object from which to retrieve keys.
     * @returns {string[]} Array of property names to be stored.
     */
    static getKeys(instance) {
        const allProps = Object.getOwnPropertyNames(instance);
        if (!allProps.length) return [];
        // Exclude functions and any ignored properties.
        const dataProps = allProps.filter(prop => !ignoreProperties.has(prop) && typeof instance[prop] !== 'function');
        return dataProps;
    }
}

/**
 * Class responsible for loading instances from the dynamic property storage.
 */
export class Load {
    /**
     * Recursively loads an instance from the dynamic property storage.
     *
     * @param {string} loadKey - The base key under which the instance was stored.
     * @param {*} storageDest - The storage destination (defaults to `world`).
     * @param {number} operations - The recursion depth (used internally for debugging).
     * @param {boolean} costumizedSaveAllowed - used internally to avoid infinite loop
     * @returns {*} The reconstructed object or value.
     */
    static loadInstance(loadKey, storageDest = world, operations = 0, costumizedSaveAllowed = true) {
        // Retrieve the type indicator for the instance.
        const instanceType = storageDest.getDynamicProperty(`${loadKey}t`);
        let keys, instance;
        if (instanceType) {
            // If the instance requires a customized load, delegate accordingly.
            if (typesWithCostumizedStorageSystem.has(instanceType) && costumizedSaveAllowed) {
                return this.costumizedLoad(instanceType, loadKey, storageDest);
            }
            // Create a new instance using the class registry.
            instance = this.createInstance(instanceType);
        }

        // Retrieve the stored keys for this instance.
        keys = storageDest.getDynamicProperty(`${loadKey}keys`);
        if (keys) {
            keys = keys.split(",");
        }
        // Special handling for arrays.
        if (!instanceType) {
            instance = {};
        }
        // Recursively load each property.
        if (keys && keys.length > 0) {
            keys = keys.filter(item => !ignoreProperties.has(item));
            keys.forEach(key => {
                const loadedInstance = Load.loadInstance(`${loadKey}${key}`, storageDest, ++operations);
                instance[abbreviationsLoad.has(key) ? abbreviationsLoad.get(key) : key] = loadedInstance;
            });
            return instance;
        } else {
            // If no keys are stored, load the value directly.
            const value = storageDest.getDynamicProperty(`${loadKey}`);
            return value;
        }
    }

    /**
     * Loads instances that require a customized loading process.
     *
     * @param {string} type - The type identifier of the instance.
     * @param {string} key - The base key for loading.
     * @param {*} storageDest - The storage destination.
     *
     * @returns {*} The reconstructed instance.
     */
    static costumizedLoad(type, loadKey, storageDest) {
        switch (type) {
            case "Array":
                const arrayLength = storageDest.getDynamicProperty(`${loadKey}length`);
                const instance = [];
                instance.length = arrayLength;
                instance.fill(1, 0, arrayLength);
                let keys = Save.getKeys(instance);
                keys = keys.filter(item => !ignoreProperties.has(item));
                keys.forEach(key => {
                    const loadedInstance = Load.loadInstance(`${loadKey}${key}`, storageDest, 0);
                    instance[abbreviationsLoad.has(key) ? abbreviationsLoad.get(key) : key] = loadedInstance;
                });
                return instance;
            default:
                // Fallback to the default load mechanism.
                return this.loadInstance(loadKey, storageDest, 0, false);
        }
    }

    /**
     * Creates a new instance of a class based on the given type.
     * The type must be registered in the KlassenRegistry.
     *
     * @param {string} type - The type identifier.
     * @returns {*} A new instance of the corresponding class.
     */
    static createInstance(type) {
        return new KlassenRegistry[type]();
    }
}
