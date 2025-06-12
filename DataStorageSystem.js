import { system, MolangVariableMap, world } from '@minecraft/server';
/*
Verbesserungs ansätze, Json Formate im Stringformat
Verschiebe Primitive auf Scoreboard/Tags, damit Dynamic-Properties nur noch komplexe Objekte enthalten; spart Speicher und CPU.

Serialisiere tiefe Objekt-Graphen in einen komprimierten JSON-Blob mit Stable-ID-Referenzen, falls du bei Welt-Properties bleiben willst.

Plane mittelfristig den Umzug auf den neuen HTTP-Client, sobald dein Projekt zwingend server-seitig läuft – damit umgehst du alle 32 kB-Limits.

Schreibe Migrations-Skripte, die alte Schlüssel automatisch ins neue Schema überführen, um Datenverlust bei API-Breaking-Changes zu vermeiden 
Bedrock Wiki
.
Halte den Code schlank: Eine einzige serialize(instance, registry)-Funktion mit WeakMap-Tracking ersetzt mehrere hundert Zeilen spezieller Save/Load-Logik und ist leichter zu testen.


*/

/**
 * Storage System for Complex Data Types in Minecraft PE Dynamic Properties
 *
 * This module provides functionality to recursively save and load complex objects
 * into Minecraft PE's dynamic properties storage. It reduces memory usage by abbreviating
 * property names and supports a robust reference-based storage system.
 *
 * The storage reference system now handles circular references correctly. Objects that reference
 * themselves directly or indirectly, as well as mutually referencing objects, are properly managed.
 */

/**
 * Registry for class constructors.
 *
 * This registry maps a type identifier to its corresponding class. During loading,
 * the registry is used to instantiate the correct class, ensuring that properties
 * and methods are restored. Each instance must have a "type" property for this
 * lookup to work.
 */
export let KlassenRegistry = null;

/**
 * Initializes the KlassenRegistry with a mapping from type strings to class constructors.
 * Be sure to include any class you wish to restore from the dynamic properties here.
 */
export function initializeClasses() {
    KlassenRegistry = {
        'Array': Array,
        "Map": Map,
        "Set": Set
    };
}

/**
 * A set of properties to ignore during the save process.
 * These typically reference large structures, dynamic caches, or
 * data that could be regenerated. Ignoring them reduces stored data volume
 * and helps to avoid redundant or circular references.
 */
const ignoreProperties = new Set([
]);

/**
 * A set of types that require custom handling during saving/loading.
 * These typically represent objects with unique serialization needs,
 * or specialized classes that don't follow the default property-based approach (e.g., a Vector class).
 */
const typesWithCostumizedStorageSystem = new Set(["Array", "storageReference", "Set", "Map"]);

/**
 * A set of types that should be saved using reference-based storage instead of
 * a direct recursive approach. This helps to avoid duplicating objects multiple times.
 */
const typesForReferenceBasedStorageSystem = new Set([
]);

/**
 * Internal map that tracks saved storage references.
 * - Key: The actual instance
 * - Value: The unique storage pointer string
 */
const savedStorageReferences = new Map();

/**
 * Internal map that tracks loaded storage references.
 * - Key: The unique storage pointer string
 * - Value: An object containing the loading state and the actual instance once loaded.
 */
const loadedStorageReferences = new Map();

/**
 * A map for abbreviating property keys during saving.
 * Reduces memory usage by replacing verbose keys with shorter equivalents.
 */
const abbreviationsMap = new Map([
    ['property', 'abbreviation']
]);

/**
 * A map for expanding abbreviated property keys during loading.
 * Restores the original property names based on abbreviated keys.
 */
const abbreviationsLoad = new Map([
    ['abbreviation', 'property']
]);

/**
 * Class responsible for saving instances to the dynamic property storage.
 * Main entry point is the static method `saveInstance()`.
 */
export class Save {
    /**
     * Recursively saves an instance to the dynamic property storage.
     *
     * @param {*} instance - The object or value to be saved.
     * @param {string} saveKey - The base key under which the instance is stored.
     * @param {*} [storageDest=world] - The storage destination (typically `world`).
     * @param {boolean} [costumizedSaveAllowed=true] - Used internally to avoid recursive reprocessing in custom saves.
     * @param {boolean} [storageReferenceAllowed=true] - Whether reference-based storage is permitted for this save path.
     *        This is set to false once a new reference is created to prevent an infinite loop.
     */
    static saveInstance(instance, saveKey, storageDest = world, costumizedSaveAllowed = true, storageReferenceAllowed = true) {
        if (instance == null) return;

        // If the instance is a simple data type, save directly.
        if (
            typeof instance === "number" ||
            typeof instance === "boolean" ||
            typeof instance === "string"
        ) {
            try {
                storageDest.setDynamicProperty(`${saveKey}`, instance);
            } catch (error) {
                console.error(
                    "Failed to save primitive property. " +
                    JSON.stringify({ saveKey, costumizedSaveAllowed })
                );
            }
            return;
        }

        instance.type = Save.getType(instance);

        // Attempt reference-based storage for known object types.
        if (storageReferenceAllowed && typesForReferenceBasedStorageSystem.has(instance.type)) {
            // If we've already saved this instance, store a reference pointer to avoid duplication.
            if (savedStorageReferences.has(instance)) {
                const pointer = savedStorageReferences.get(instance);
                this.saveInstance(
                    { type: "storageReference", pointer: pointer },
                    saveKey,
                    storageDest,
                    true,
                    true
                );
                return;
            } else {
                // Create a new unique pointer and store the object there.
                const pointer = saveKey + V3Collection.generateRandomStringWithSymbols(35);
                savedStorageReferences.set(instance, pointer);

                // Save the full object at the new pointer (with references disabled to prevent infinite recursion).
                this.saveInstance(instance, pointer, storageDest, true, false);

                // Store a reference to that newly saved object.
                this.saveInstance(
                    { type: "storageReference", pointer: pointer },
                    saveKey,
                    storageDest,
                    true,
                    true
                );
                return;
            }
        }

        // If the object has a type that demands custom saving, handle it separately.
        if (instance.type && typesWithCostumizedStorageSystem.has(instance.type) && costumizedSaveAllowed) {
            this.costumizedSave(instance, saveKey, storageDest);
            return;
        }

        // Otherwise, perform default saving logic:
        // 1) Collect keys (excluding functions and ignored properties).
        // 2) Abbreviate keys if applicable.
        // 3) Store them for retrieval later.
        const keys = this.getKeys(instance);
        storageDest.setDynamicProperty(
            `${saveKey}keys`,
            keys.map(k => abbreviationsMap.has(k) ? abbreviationsMap.get(k) : k).join(",")
        );

        // Recursively save each property.
        for (const key of keys) {
            const prop = instance[key];
            const saveKeyAbbreviated = abbreviationsMap.get(key) ?? key;

            try {
                Save.saveInstance(prop, `${saveKey}${saveKeyAbbreviated}`, storageDest);
            } catch (error) {
                console.error(
                    "Failed to recursively save property. " +
                    JSON.stringify({ key, saveKey })
                );
            }
        }
    }

    static getType(instance) {
        // If the instance is an Array, mark with a type for specialized loading.
        if (Array.isArray(instance)) {
            return "Array";
        }
        if (instance instanceof Map) {
            return "Map"
        }
        if (instance instanceof Set) {
            return "Set"
        }
        return instance.type;
    }

    /**
     * Saves instances that require a customized storage process.
     * Used for types specified in `typesWithCostumizedStorageSystem`.
     *
     * @param {*} instance - The object to be saved.
     * @param {string} saveKey - The base key for storage.
     * @param {*} storageDest - The storage destination (usually `world`).
     */
    static costumizedSave(instance, saveKey, storageDest) {
        switch (instance.type) {
            case "Array":
                // For arrays, store 'length' and 'type' as properties, then individually save items.
                try {
                    const keysToSave = ["length", "type"];
                    storageDest.setDynamicProperty(
                        `${saveKey}keys`,
                        keysToSave.map(k => abbreviationsMap.has(k) ? abbreviationsMap.get(k) : k).join(",")
                    );
                } catch (error) {
                    console.error(
                        "Failed to save array properties. " +
                        JSON.stringify({ saveKey })
                    );
                }
                // Recursively save each element of the array.
                const arrKeys = this.getKeys(instance);
                for (const key of arrKeys) {
                    const prop = instance[key];
                    const saveKeyAbbreviated = abbreviationsMap.get(key) ?? key;
                    Save.saveInstance(prop, `${saveKey}${saveKeyAbbreviated}`, storageDest);
                }
                break;
            case "Set":
                try {
                    // Store the type and size of the Set.
                    storageDest.setDynamicProperty(`${saveKey}type`, "Set");
                    storageDest.setDynamicProperty(`${saveKey}size`, instance.size);

                    // Store each element under a sequential key.
                    let idx = 0;
                    for (const item of instance) {
                        Save.saveInstance(
                            item,
                            `${saveKey}item${idx}`,
                            storageDest
                        );
                        idx++;
                    }
                } catch (error) {
                    console.error(
                        "Failed to save Set property. " +
                        JSON.stringify({  saveKey })
                    );
                }
                break;
            case "Map":
                try {
                    // Store the type and size of the Map.
                    storageDest.setDynamicProperty(`${saveKey}type`, "Map");
                    storageDest.setDynamicProperty(`${saveKey}size`, instance.size);
                    // Store each entry as separate key/value pairs.
                    let idx = 0;
                    for (const [key, value] of instance) {
                        Save.saveInstance(
                            key,
                            `${saveKey}key${idx}`,
                            storageDest
                        );
                        Save.saveInstance(
                            value,
                            `${saveKey}value${idx}`,
                            storageDest
                        );
                        idx++;
                    }
                } catch (error) {
                    console.error(
                        "Failed to save Map property. " +
                        JSON.stringify({ saveKey })
                    );
                }
                break;
            default:
                // Fallback to the default save, but with custom saving disabled for this pass
                // to avoid an infinite loop back into costumizedSave.
                this.saveInstance(instance, saveKey, storageDest, false);
                break;
        }
    }

    /**
     * Retrieves property names from an instance that should be saved.
     * Excludes any that are functions or listed in `ignoreProperties`.
     *
     * @param {*} instance - The object from which to retrieve keys.
     * @param {boolean} [filter=true] - Whether to filter out ignored properties.
     * @returns {string[]} Array of property names to be stored.
     */
    static getKeys(instance, filter = true) {
        const allProps = Object.getOwnPropertyNames(instance);
        if (!allProps.length) return [];

        return allProps.reduce((acc, prop) => {
            if ((filter && !ignoreProperties.has(prop)) && typeof instance[prop] !== 'function') {
                acc.push(prop);
            }
            return acc;
        }, []);
    }

}

/**
 * Class responsible for loading instances from the dynamic property storage.
 * Main entry point is the static method `loadInstance()`.
 */
export class Load {
    /**
     * Recursively loads an instance from the dynamic property storage.
     *
     * @param {string} loadKey - The base key under which the instance was stored.
     * @param {*} [storageDest=world] - The storage destination (typically `world`).
     * @param {boolean} [costumizedSaveAllowed=true] - Used internally to avoid recursive reprocessing in custom saves.
     * @returns {*} The reconstructed object or value.
     */
    static loadInstance(loadKey, storageDest = world, costumizedSaveAllowed = true) {
        // Check if there's a type field stored (e.g. "t").
        const instanceType = storageDest.getDynamicProperty(`${loadKey}t`);
        let instance = false;

        // If a known type is found and it requires custom loading, delegate.
        if (instanceType && typesWithCostumizedStorageSystem.has(instanceType) && costumizedSaveAllowed) {
            return this.costumizedLoad(instanceType, loadKey, storageDest);
        }

        // If there's a type stored, attempt to create an instance from the class registry.
        if (instanceType && KlassenRegistry[instanceType]) {
            instance = this.createInstance(instanceType);
        }

        // Retrieve stored keys (may be abbreviated).
        let keys = storageDest.getDynamicProperty(`${loadKey}keys`);
        if (keys) {
            keys = keys.split(",");
        }

        // If we still don't have an instance, default to an empty object.
        if (!instance) {
            instance = {};
        }

        // Recursively load each stored property.
        if (keys && keys.length > 0) {
            // Filter out ignored properties.
            keys = keys.filter(item => !ignoreProperties.has(item));
            for (const key of keys) {
                const loadedInstance = Load.loadInstance(`${loadKey}${key}`, storageDest);
                instance[abbreviationsLoad.get(key) ?? key] = loadedInstance;
            }
            return instance;
        } else {
            // No stored keys: it could be a primitive or direct data value.
            const value = storageDest.getDynamicProperty(`${loadKey}`);
            return value;
        }
    }

    /**
     * Loads instances that require a specialized loading process.
     * Used for types specified in `typesWithCostumizedStorageSystem`.
     *
     * @param {string} type - The stored type identifier (e.g., "V").
     * @param {string} loadKey - The base key from which data is loaded.
     * @param {*} storageDest - The storage destination (usually `world`).
     * @returns {*} The reconstructed instance.
     */
    static costumizedLoad(type, loadKey, storageDest) {
        switch (type) {
            case "Array":
                const arrayLength = storageDest.getDynamicProperty(`${loadKey}length`);
                const arrInstance = [];
                arrInstance.length = arrayLength;
                arrInstance.fill(1, 0, arrayLength);

                let arrKeys = Save.getKeys(arrInstance);
                arrKeys = arrKeys.filter(item => !ignoreProperties.has(item));

                for (const key of arrKeys) {
                    const loaded = Load.loadInstance(`${loadKey}${key}`, storageDest);
                    arrInstance[abbreviationsLoad.get(key) ?? key] = loaded;
                }
                return arrInstance;

            case "storageReference":
                // For reference types, check if the pointer has been loaded.
                // If encountered during circular references, a placeholder is used and later completed.
                const pointer = storageDest.getDynamicProperty(`${loadKey}pointer`);
                if (loadedStorageReferences.has(pointer)) {
                    const loadingInfos = loadedStorageReferences.get(pointer);
                    if (loadingInfos.isLoaded) {
                        return loadingInfos.value;
                    } else {
                        return { type: "storageReference", pointer };
                    }
                } else {
                    // Mark the pointer as not yet loaded.
                    loadedStorageReferences.set(pointer, { isLoaded: false, value: null });
                    const loadedObj = this.loadInstance(pointer, storageDest);
                    loadedStorageReferences.set(pointer, { isLoaded: true, value: loadedObj });
                    this.completeMissingProperties(loadedObj);
                    return loadedObj;
                }

            case "Set": {
                const size = storageDest.getDynamicProperty(`${loadKey}size`);
                const result = new Set();
                // Load each element by index and add to the Set.
                for (let i = 0; i < size; i++) {
                    const item = Load.loadInstance(
                        `${loadKey}item${i}`,
                        storageDest
                    );
                    result.add(item);
                }
                return result;
            }

            case "Map": {
                const size = storageDest.getDynamicProperty(`${loadKey}size`);
                const result = new Map();
                // Load each key/value pair by index and set in the Map.
                for (let i = 0; i < size; i++) {
                    const key = Load.loadInstance(
                        `${loadKey}key${i}`,
                        storageDest
                    );
                    const value = Load.loadInstance(
                        `${loadKey}value${i}`,
                        storageDest
                    );
                    result.set(key, value);
                }
                return result;
            }
            default:
                // Fallback to the default load mechanism, disabling custom load to avoid infinite loops.
                return this.loadInstance(loadKey, storageDest, false);
        }
    }

    /**
     * Creates a new instance of a class based on the given type,
     * using the KlassenRegistry. The type must already be registered.
     *
     * @param {string} type - The type identifier (e.g. "MissileLauncher").
     * @returns {*} A new instance of the corresponding class.
     */
    static createInstance(type) {
        return new KlassenRegistry[type]();
    }

    /**
     * Recursively completes missing properties for objects that were partially loaded
     * due to circular references. If an object is a placeholder (a storageReference),
     * it is replaced by the fully loaded object. This ensures that all mutually referencing
     * objects are properly linked in the final reconstructed instance.
     *
     * @param {*} instance - The object to complete.
     * @param {*} [parent=null] - (Optional) The parent object that holds the current instance.
     * @param {string} [prop=null] - (Optional) The property name in the parent where the instance is stored.
     */
    static completeMissingProperties(instance, parent = null, prop = null) {
        if (
            typeof instance === "number" ||
            typeof instance === "boolean" ||
            typeof instance === "string" ||
            instance == null
        ) return;
        const keys = Save.getKeys(instance, false);
        if (keys.length <= 0) return;
        if (instance.type == "storageReference" && loadedStorageReferences.has(instance.pointer)) {
            if (parent != null) parent[prop] = loadedStorageReferences.get(instance.pointer).value;
            return;
        }
        for (let key of keys) {
            this.completeMissingProperties(instance[key], instance, key);
        }
    }
}
