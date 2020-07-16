/* eslint-disable max-len */
/* eslint-disable no-param-reassign */
const Endpoints = require('../../resources/Endpoints');
const List = require('../Util/List');
const PartyMeta = require('./PartyMeta');
const PartyMember = require('./PartyMember');
const ClientPartyMember = require('./ClientPartyMember');
const { PartyPrivacy } = require('../../enums');

/**
 * A party
 */
class Party {
  /**
   * @param {Object} client main client
   * @param {Object} data party data
   */
  constructor(client, data) {
    Object.defineProperty(this, 'Client', { value: client });
    Object.defineProperty(this, 'data', { value: data });

    /**
     * The id of this party
     */
    this.id = data.id;

    /**
     * Date when this party was created
     */
    this.createdAt = new Date(data.created_at);

    /**
     * This parties config
     */
    this.config = { ...this.Client.config.partyConfig, ...this.Client.makeCamelCase(data.config) };

    /**
     * The parties members
     */
    this.members = new List();
    data.members.forEach((m) => {
      if (this.id === this.Client.account.id) this.members.set(m.account_id, new ClientPartyMember(this, m));
      else this.members.set(m.account_id, new PartyMember(this, m));
    });

    /**
     * If the party is currently sending a patch
     */
    this.currentlyPatching = false;

    /**
     * The queue for patches
     */
    this.patchQueue = [];

    /**
     * This parties meta
     */
    this.meta = new PartyMeta(this, data.meta);

    /**
     * This parties revision
     */
    this.revision = data.revision || 0;

    if (!this.id) throw new Error('Cannot initialize party without an id');
  }

  /**
   * The client party member
   * @type {ClientPartyMember}
   */
  get me() {
    return this.members.get(this.Client.account.id);
  }

  /**
   * The party leader
   * @type {PartyMember}
   */
  get leader() {
    return this.members.find((m) => m.isLeader);
  }

  /**
   * Join this party
   */
  async join() {
    if (this.Client.party) await this.Client.party.leave();
    const party = await this.Client.Http.send(true, 'POST',
      `${Endpoints.BR_PARTY}/parties/${this.id}/members/${this.Client.account.id}/join`, `bearer ${this.Client.Auth.auths.token}`, null, {
        connection: {
          id: this.Client.Xmpp.stream.jid,
          meta: {
            'urn:epic:conn:platform_s': this.Client.config.platform,
            'urn:epic:conn:type_s': 'game',
          },
          yield_leadership: false,
        },
        meta: {
          'urn:epic:member:dn_s': this.Client.account.displayName,
          'urn:epic:member:joinrequestusers_j': JSON.stringify({
            users: [
              {
                id: this.Client.account.id,
                dn: this.Client.account.displayName,
                plat: this.Client.config.short,
                data: JSON.stringify({
                  CrossplayPreference: '1',
                  SubGame_u: '1',
                }),
              },
            ],
          }),
        },
      });
    if (!party.success) throw new Error(`Failed joining party: ${this.Client.parseError(party.response)}`);
    this.Client.party = this;
  }

  /**
   * Send an updated presence via xmpp
   */
  patchPresence() {
    const partyJoinInfoData = this.config.privacy.presencePermission === 'None'
      || (this.Client.party.config.privacy.presencePermission === 'Leader' && this.leader.id === this.Client.account.id)
      ? {
        bIsPrivate: true,
      } : {
        sourceId: this.Client.account.id,
        sourceDisplayName: this.Client.account.displayName,
        sourcePlatform: this.Client.config.platform,
        partyId: this.id,
        partyTypeId: 286331153,
        key: 'k',
        appId: 'Fortnite',
        buildId: '1:1:',
        partyFlags: -2024557306,
        notAcceptingReason: 0,
        pc: this.members.size,
      };
    const properties = {
      'party.joininfodata.286331153_j': partyJoinInfoData,
      FortBasicInfo_j: {
        homeBaseRating: 1,
      },
      FortLFG_I: '0',
      FortPartySize_i: 1,
      FortSubGame_i: 1,
      InUnjoinableMatch_b: false,
      FortGameplayStats_j: {
        state: '',
        playlist: 'None',
        numKills: 0,
        bFellToDeath: false,
      },
    };
    const presence = {
      Status: '',
      bIsPlaying: true,
      bIsJoinable: false,
      bHasVoiceSupport: false,
      SessionId: '',
      Properties: properties,
    };
    this.Client.Xmpp.sendStatus(presence);
  }

  /**
   * Leave this party
   * @param {Boolean} createNew if a new party should be created
   */
  async leave(createNew = true) {
    const party = await this.Client.Http.send(true, 'DELETE',
      `${Endpoints.BR_PARTY}/parties/${this.id}/members/${this.Client.account.id}`, `bearer ${this.Client.Auth.auths.token}`);
    if (!party.success) throw new Error(`Failed leaving party: ${this.Client.parseError(party.response)}`);
    this.Client.party = undefined;

    if (createNew) await Party.Create(this.Client);
  }

  /**
   * Send a patch with the latest meta
   * @param {Object} updated updated data
   * @param {Boolean} isForced if the patch should ignore current patches
   */
  async sendPatch(updated, deleted, isForced) {
    if (!isForced && this.currentlyPatching) {
      this.patchQueue.push([updated]);
      return;
    }
    this.currentlyPatching = true;

    const patch = await this.Client.Http.send(true, 'PATCH',
      `${Endpoints.BR_PARTY}/parties/${this.id}`, `bearer ${this.Client.Auth.auths.token}`, null, {
        config: {
          join_confirmation: this.config.joinConfirmation,
          joinability: this.config.joinability,
          max_size: this.config.maxSize,
        },
        meta: {
          delete: deleted || [],
          update: updated || this.meta.schema,
        },
        party_state_overridden: {},
        party_privacy_type: this.config.joinability,
        party_type: this.config.type,
        party_sub_type: this.config.subType,
        max_number_of_members: this.config.maxSize,
        invite_ttl_seconds: this.config.inviteTTL,
        revision: this.revision,
      });
    if (patch.success) {
      this.revision += 1;
    } else {
      switch (patch.response.errorCode) {
        case 'errors.com.epicgames.social.party.stale_revision':
          [, this.revision] = patch.response.messageVars;
          this.patchQueue.push([updated]);
          break;
        case 'errors.com.epicgames.social.party.party_change_forbidden':
          throw new Error('Cannot patch party as client isnt party leader');
        default: break;
      }
    }

    if (this.patchQueue.length > 0) {
      const args = this.patchQueue.shift();
      this.sendPatch(...args, true);
    } else {
      this.currentlyPatching = false;
    }
    if (this.Client.config.savePartyMemberMeta) this.Client.lastMemberMeta = this.meta.schema;
  }

  /**
   * Update this parties meta with xmpp data
   * @param {Object} data xmpp data
   */
  update(data) {
    if (data.revision > this.revision) this.revision = data.revision;
    this.meta.update(data.party_state_updated, true);
    this.meta.remove(data.party_state_removed);

    this.config.joinability = data.party_privacy_type;
    this.config.maxSize = data.max_number_of_members;
    this.config.subType = data.party_sub_type;
    this.config.type = data.party_type;
    this.config.inviteTTL = data.invite_ttl_seconds;

    let privacy = this.meta.get('PrivacySettings_j');
    privacy = Object.values(PartyPrivacy)
      .find((val) => val.partyType === privacy.PrivacySettings.partyType
        && val.inviteRestriction === privacy.PrivacySettings.partyInviteRestriction
        && val.onlyLeaderFriendsCanJoin === privacy.PrivacySettings.bOnlyLeaderFriendsCanJoin);
    if (privacy) this.config.privacy = privacy;
  }

  /**
   * Set this parties privacy
   * @param privacy updated privacy
   */
  async setPrivacy(privacy) {
    const updated = {};
    const deleted = [];

    const privacySettings = this.meta.get('Default:PrivacySettings_j');
    if (privacySettings) {
      updated.PrivacySettings_j = this.meta.set('Default:PrivacySettings_j', {
        PrivacySettings: {
          ...privacySettings.PrivacySettings,
          partyType: privacy.partyType,
          bOnlyLeaderFriendsCanJoin: privacy.onlyLeaderFriendsCanJoin,
          partyInviteRestriction: privacy.inviteRestriction,
        },
      });
    }

    updated['urn:epic:cfg:presence-perm_s'] = this.meta.set('urn:epic:cfg:presence-perm_s', privacy.presencePermission);
    updated['urn:epic:cfg:accepting-members_b'] = this.meta.set('urn:epic:cfg:accepting-members_b', privacy.acceptingMembers);
    updated['urn:epic:cfg:invite-perm_s'] = this.meta.set('urn:epic:cfg:invite-perm_s', privacy.invitePermission);

    if (['Public', 'FriendsOnly'].indexOf(privacy.partyType) > -1) deleted.push('urn:epic:cfg:not-accepting-members');

    if (privacy.partyType === 'Private') {
      updated['urn:epic:cfg:not-accepting-members-reason_i'] = 7;
    } else deleted.push('urn:epic:cfg:not-accepting-members-reason_i');

    await this.sendPatch(updated, deleted);
  }

  /**
   * Lookup which parties the client user is in / got invited to
   * @param {Object} client the main client
   */
  static async LookupSelf(client) {
    const party = await client.Http.send(true, 'GET', `${Endpoints.BR_PARTY}/user/${client.account.id}`, `bearer ${client.Auth.auths.token}`);
    if (!party.success) throw new Error(`Failed looking up clientparty: ${client.parseError(party.response)}`);
    if (!party.response.current[0]) return undefined;
    return new Party(client, party.response.current[0]);
  }

  /**
   * Create a party
   * @param {Object} client the main client
   */
  static async Create(client, config) {
    const partyConfig = { ...client.config.partyConfig, ...config };
    const party = await client.Http.send(true, 'POST', `${Endpoints.BR_PARTY}/parties`, `bearer ${client.Auth.auths.token}`, null, {
      config: {
        join_confirmation: partyConfig.joinConfirmation,
        joinability: partyConfig.joinability,
        max_size: partyConfig.maxSize,
      },
      join_info: {
        connection: {
          id: client.Xmpp.stream.jid,
          meta: {
            'urn:epic:conn:platform_s': client.config.platform,
            'urn:epic:conn:type_s': 'game',
          },
          yield_leadership: false,
        },
        meta: {
          'urn:epic:member:dn_s': client.account.displayName,
        },
      },
      meta: {
        'urn:epic:cfg:party-type-id_s': 'default',
        'urn:epic:cfg:build-id_s': '1:1:',
        'urn:epic:cfg:join-request-action_s': 'Manual',
        'urn:epic:cfg:chat-enabled_b': partyConfig.chatEnabled.toString(),
      },
    });

    if (!party.success) throw new Error(`Failed creating party: ${client.parseError(party.response)}`);

    party.response.config = { ...partyConfig, ...party.response.config || {} };
    const clientParty = new Party(client, party.response);
    await clientParty.setPrivacy(clientParty.config.privacy);

    client.party = clientParty;
    return clientParty;
  }
}

module.exports = Party;