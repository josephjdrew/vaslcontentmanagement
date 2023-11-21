var Class = System.getModule("com.vmware.pscoe.library.class").Class();
var Base = Class.load("com.vmware.pscoe.cba", "Base");
var ContextFactory = Class.load("com.vmware.pscoe.library.context", "ContextFactory");
 
var context = ContextFactory.createLazy([
]);
 
var logger = System.getModule("com.vmware.pscoe.library.logging")
    .getLogger("com.vmware.pso.util/IPAMService");
 
function getRanges(ipamIntegration) {
    //Get External IPAM ranges that have been ingested by vAA
    var response = JSON.parse(System.getModule("com.vmware.pso.util").vraExecuteRestAction('GET', "/iaas/api/external-network-ip-ranges?$limit=10000", null)).content;
 
    //Get target IPAM Integration ID
    var ipamIntegrations = System.getModule("com.vmware.pso.util").getIPAMIntegrations();
    var ipamIntegrationID;
    for each(integration in ipamIntegrations) {
        if(integration.name.indexOf(ipamIntegration) !== -1){
            ipamIntegrationID = integration.id;
        }
    }
 
    var ranges = [];
 
    //Check that range is from selected integration
    for each(range in response) {
        if(range.integrationId == ipamIntegrationID){
            ranges.push(range);
        }
    }
 
    return ranges;
};
 
return Class.define(function IPAMMappingService(dryRun, ipamIntegrationName, networksAccount) {
    Base.call(this);
    this.dryRun = dryRun;
    this.ipamIntegrationName = ipamIntegrationName;
    this.networksAccount = networksAccount;
    this.currentvaaNetworks = [];
    this.currentRange;
    this.currentTags;
    this.mappingResults = [];
    this.vRAHost = Server.findAllForType('VRA:Host')[0];
    this.networks = VraEntitiesFinder.getFabricNetworks(this.vRAHost);
    this.networkProfiles = VraEntitiesFinder.getNetworkProfiles(this.vRAHost);
 
}, {
 
    /**
     * Main function to be called on the IPAMMappingService object which
     * performs end to end mapping.
     */
 
    performIPAMMapping: function () {
        var ranges = getRanges(ipamIntegrationName);
    
        while (ranges.length > 0) {
            this.currentRange = ranges.pop();
            this.checkRangeAndMap();
    
            if (!this.currentRange) {
                // Skip further processing if the range is unsuitable for mapping
                this.resetRunVariables();
                continue;
            }
    
            this.findMatchingNetworks();
    
            if (!this.currentvaaNetworks[0]) {
                // Skip processing if no matching networks were found
                this.resetRunVariables();
                continue;
            }
    
            // Perform IPAM range to network mapping and tagging
            this.ipamRangeToNetworkMapping();
            this.applyNetworkTags();
    
            // Update matching Network Profile if tags were set
            if (this.currentTags) {
                this.updateNetworkProfile();
            }
 
            //Reset current run variables
            this.resetRunVariables();
        }
    
        return this.mappingResults;
    },
 
    /**
     * Resets the current run variables which temporarily store the
     * current IPAM range, translated tags and matching vAA Fabric Networks
     */
    
    resetRunVariables: function () {
        this.currentRange = null;
        this.currentTags = null;
        this.currentvaaNetworks = [];
    },
 
    /**
     * Validates the current run range is eligible for mapping and tagging.
     * This is done by translating the Infoblox EA values to vAA tags.
     * Based on whether the required tags are present (for vRA 7.6 and/or 8 provisioning),
     * the currentRange will remain set and have the currentTags variable set if it should
     * be used for vAA provisioning. If the range is only to be used with 7.6, currentRange
     * will remain set, but currentTags will be empty. Only mapping for decom purposes will occur.
     * Both the currentRange and currentTags will be null if the range is not eligible.
     */
 
    checkRangeAndMap: function () {
        var writeTags = true;
        var performMapping = true;
        var ipamName;
 
        this.currentTags = {
            vmenv: [],
            networktenancy: [],
            az: [],
            securityzone: [],
            pod: [],
            service: [],
            tier: ["general"]
        };
 
        //Don't look at F5 Networks
        if (this.currentRange.description && this.currentRange.description.indexOf("F5") == -1) {
            ipamName = this.currentRange.name;
 
            for each(tag in this.currentRange.tags){
                var splitValues = [];
 
                //Some Infoblox EA values are an array in string form. Here we format the array string so it can be parsed as a JSON array object.
                if(tag.value.charAt(0) == '[') {
                var jsonArrayString = tag.value.replace(/'/g, "\"").toLowerCase();
                splitValues = JSON.parse(jsonArrayString);
            }
    else splitValues.push(tag.value.toLowerCase());
 

        //Perform Infoblox EA Key mapping to vAA Keys, and insert tag values
        switch (tag.key) {
            case ("Environment"):
                this.currentTags.vmenv = this.currentTags.vmenv.concat(splitValues);
                break;
            case ("TenancyType"):
                this.currentTags.networktenancy = this.currentTags.networktenancy.concat(splitValues);
                break;
            case ("DataCentre"):
                this.currentTags.az = this.currentTags.az.concat(splitValues);
                break;
            case ("SecurityZone"):
                //Account for "SecurityZone:Managment" Infoblox EA in Dev/Test. This condition can be removed once this EA value is updated to "SecurityZone:Management" to align with vAA Tagging structure.
                for(index in splitValues) {
                    if (splitValues[index] == "managment") splitValues[index] = "management";
                }
                this.currentTags.securityzone = this.currentTags.securityzone.concat(splitValues);
                break;
            case ("Pod"):
                this.currentTags.pod = this.currentTags.pod.concat(splitValues)
                break;
            case ("ServiceTier"):
                this.currentTags.service = this.currentTags.service.concat(splitValues);
                break;
            default:
                break;
        }
    }
 
}
else {
        writeTags = false;
        performMapping = false;
    }
 
//Don't map/tag if the Cloud Account's AZ and the Infoblox Range's Datacentre (az) EA don't match 
if (this.currentTags.az.length > 0) {
    //Default account AZ of Norwest. Will set to Burwood if Burwood is present in the Cloud Account Name
    var accountAZ = networksAccount.name.indexOf("Burwood") == -1 ? "norwest" : "burwood";
    if (this.currentTags.az.indexOf(accountAZ) == -1) {
        writeTags = false;
        performMapping = false;
    }
}
 
for (tagKey in this.currentTags) {
    //Don't write tags if a required tag is empty (can't provision to this network without all required tags). Also don't continue with the IPAM mapping.
    if (this.currentTags[tagKey].length == 0) {
        System.log("Skipping network tagging for range '" + ipamName + "'. Mandatory Tag '" + tagKey + "' is missing.");
        writeTags = false;
        performMapping = false;
    }
 
    //Don't write tags for provisioning if the network has a pod3 tag, but not a pod3_vaa one. This is a 7.6 network that
    //shouldn't be provisioned to from vAA, but we need the mapping for decom of onboarded VMs
    if (tagKey == "pod" && this.currentTags[tagKey].indexOf("pod3") !== -1) {
        var vaaSearchIndex = this.currentTags[tagKey].indexOf("pod3_vaa");
        if (vaaSearchIndex == -1) {
            System.log("Range/Network '" + ipamName + "' appears to be a Pod3 Network not used for vAA Provisioning. Tags will not be written. ");
            writeTags = false;
        }
        else {
            //If the Infoblox Range has a pod:pod3 and pod:pod3_vaa EA, then we want to provision to it. However, we don't need the pod:pod3_vaa tag as it is not targeted by vAA provisioning.
            this.currentTags[tagKey].splice(vaaSearchIndex, vaaSearchIndex);
        }
    }
    //Else if there is just a pod:pod3_vaa EA, then we will use it for vAA provisioning. However, we use the pod:pod3 tag 
    else if (tagKey == "pod" && this.currentTags[tagKey].indexOf("pod3_vaa") !== -1) {
        this.currentTags.pod = ["pod3"];
    }
}
 
/*If one of the above conditions has failed for tagging, then empty out the array of tags.
If one of the conditions for performing IPAM Range to vAA Network Mapping has failed, set the IPAM range to null */
if (!performMapping) this.currentRange = null;
if (!writeTags) this.currentTags = null;
 
},
/**
 * Function to find vAA Fabric Networks which match the IPAM currentRange
 */
 
findMatchingNetworks: function () {
    var ipamName = this.currentRange.name;



    //Remove anything after the slash
    var search = ipamName.split("/")[0];
    System.log("Took the following IPAM name: " + ipamName + ". Have translated it to the following: " + search);
 
    for each(network in this.networks){
        if(network.name.indexOf(search) !== -1 && network.cloudAccountIds[0] == networksAccount.id)  {
            this.currentvaaNetworks.push(network);
        }
 
}
},
 
/**
 * Function to map the IPAM range to the vAA Fabric Network
 */
 
ipamRangeToNetworkMapping: function () {
    for each(vaaNetwork in this.currentvaaNetworks){
        if(!this.dryRun) {
            //Payload to map IP Range to Network
            var payload = {
                "fabricNetworkIds": [
                    vaaNetwork.id
                ]
            };
 
            //Perform IP Range to Network Mapping
            var ipamMapResponse = JSON.parse(System.getModule("com.vmware.pso.util").vraExecuteRestAction('PATCH', "/iaas/api/external-network-ip-ranges/" + this.currentRange.id, JSON.stringify(payload)));
        }
 
System.log("Identified the following pair to match. vAA Fabric Network Name:  " + vaaNetwork.name + " to be used with IPAM Range: " + this.currentRange.name);
 
};
},
 
    /**
 * This function will work whether tags are present or not. 
 * 
 * 1. When we have a network that we don't wish to provision to, the tags array will be empty.
 * 2. When we call a PATCH to the Fabric Networks API, the array will be empty.
 * 3. Given this is absolute, the network will no longer have any tags on it. 
 * 
 */
 
applyNetworkTags: function () {



    for each(vaaNetwork in this.currentvaaNetworks) {
        var tagsPayload = {
            "tags": []
        }
 
        //For each tag type
        for(tagKey in this.currentTags) {
            for each(tagValue in this.currentTags[tagKey]) {
        var tagJSON = {
            "key": tagKey,
            "value": tagValue
        }
        tagsPayload.tags.push(tagJSON);
    }
}
 
System.log("Putting the following tags on the above mapping: " + JSON.stringify(tagsPayload));
 
if (!dryRun) {
    var taggingRepsonse = JSON.parse(System.getModule("com.vmware.pso.util").vraExecuteRestAction('PATCH', "/iaas/api/fabric-networks/" + vaaNetwork.id, JSON.stringify(tagsPayload)));
}
 
System.log("Putting the following tags on the above mapping: " + JSON.stringify(tagsPayload));
 

//Log the results
var result = {
    "vaaNetwork": vaaNetwork.name,
    "ipamRange": this.currentRange.name,
    "tagsPayload": tagsPayload
}
 
this.mappingResults.push(result);
};
},
 
/**
 * This function updates or creates a network profile after IPAM Range to vAA Fabric network
 * mapping is done, and tags are applied to the network. The network profile is only required
 * for native provisioning.
 */
 
updateNetworkProfile: function () {
    var targetNetworkProfile;
    var search = this.currentRange.name.split("/")[0];
    var existingNetworkIDs = [];
 
    for each(networkProfile in this.networkProfiles) {
        if(networkProfile.name.indexOf(search) !== -1 && this.networksAccount.id == networkProfile.cloudAccountId) targetNetworkProfile = networkProfile;
    };
 
    if (targetNetworkProfile) {
            var networkLinks = JSON.parse(targetNetworkProfile.linksExtension)["fabric-networks"]["hrefs"];
 
            for each(networkLink in networkLinks){
                existingNetworkIDs.push(networkLink.split("/iaas/api/fabric-networks/")[1]);
            }
    }



    for each(network in this.currentvaaNetworks) {
        if(targetNetworkProfile) {
            var needsAddingToExistingProfile = true;
            for each(existingNetworkID in existingNetworkIDs){
                if(existingNetworkID == network.id) needsAddingToExistingProfile = false;
        }
 
                if(needsAddingToExistingProfile && !this.dryyRun) {
        targetNetworkProfile.putLinksItem("/iaas/api/fabric-networks/" + network.id);
    }
}
            else {
    var networkProfilePayload = {
        name: this.currentRange.name,
        description: this.currentRange.description,
        regionId: JSON.parse(this.networksAccount.enabledRegionIdsExtension)[0].links.self.href.split("/iaas/api/regions/")[1],
        fabricNetworkIds: [
            network.id
        ]
    }
    if (!this.dryRun) {
        System.getModule("com.vmware.pso.util").vraExecuteRestAction('POST', "/iaas/api/network-profiles/", JSON.stringify(networkProfilePayload));
    }
    //Update array of Network Profiles used by service after updates performed.
        this.networkProfiles = VraEntitiesFinder.getNetworkProfiles(this.vRAHost);
 
}
 
}
 
}},
 
Base);
