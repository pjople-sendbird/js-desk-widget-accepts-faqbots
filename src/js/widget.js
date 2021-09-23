import SendBird from 'sendbird';
import SendBirdDesk from 'sendbird-desk';

import { simplify } from './simplify.js';
import { parseDom } from './domparser.js';
import Broadcast from './broadcast.js';

import Dialog from './component/dialog.js';
import Spinner from './component/spinner.js';
import TicketElement from './component/ticket.js';
import MessageElement from './component/message.js';
import NotificationElement from './component/notification.js';

/** Default settings
 */
const connectionError = 'Cannot connect to internet.';

const DEBUG = true;

export default class Widget {
  constructor(user, options) {
    /** Build UI elements
     */
    this.element = document.getElementById('sb-desk');
    this.element.className = '-sbd-widget';
    if (!options) options = {};
    if (!options.apiHost) options['apiHost'] = '';
    if (!options.wsHost) options['wsHost'] = '';
  
    Widget.panel = this.panel = parseDom(`<div class='-sbd-panel'>
            <div class='-sbd-header'>
                <div class='-sbd-title'>Inbox</div>
                <div class='-sbd-tabs'>
                    <div class='-sbd-tab-item' data-status='${SendBirdDesk.Ticket.Status.OPEN}'>OPEN</div>
                    <div class='-sbd-tab-item' data-status='${SendBirdDesk.Ticket.Status.CLOSED}'>CLOSED</div>
                    <div class='-sbd-tab-bar'></div>
                </div>
                <div class='-sbd-menu'><div class='icon'></div></div>
                <div class='-sbd-menu-list'>
                  <div class='-sbd-menu-item' data-cmd='signout'>Sign out</div>
                </div>
            </div>
            <div class='-sbd-ticket-list'>
                <div class='-sbd-ticket-new'>
                    <div class='icon'></div>
                    <div class='label'>Start a new conversation.</div>
                </div>
            </div>
            <div class='-sbd-error'>${connectionError}</div>
        </div>`);
    this.element.appendChild(this.panel);
    this.error = simplify(this.element.querySelector('.-sbd-error'));

    let tabs = simplify(document.querySelectorAll('.-sbd-tabs > .-sbd-tab-item'));
    let tabBar = simplify(document.querySelector('.-sbd-tabs > .-sbd-tab-bar'));
    for (let i = 0; i < tabs.length; i++) {
      tabs[i].on('click', e => {
        let status = e.target.getAttribute('data-status');
        selectTab(status);
      });
    }

    let menu = simplify(document.querySelector('.-sbd-menu'));
    let menuList = simplify(document.querySelector('.-sbd-menu-list'));
    menu.on('click', () => menuList.toggleClass('fade-in'));

    let menus = simplify(document.querySelectorAll('.-sbd-menu-list > .-sbd-menu-item'));
    for (let i = 0; i < menus.length; i++) {
      menus[i].on('click', e => {
        let cmd = e.target.getAttribute('data-cmd');
        switch (cmd) {
          case 'signout':
            this.signout();
            break;
        }
        menuList.toggleClass('fade-in');
      });
    }

    this.ticketList = simplify(document.querySelector('.-sbd-panel > .-sbd-ticket-list'));
    this.ticketElementList = [];

    this.ticketRevision = 0;
    this.isLoading = false;
    this.noMoreTicket = false;
    this.ticketList.on('scroll', () => {
      if (!this.isLoading && !this.noMoreTicket && this.isBottom()) {
        this.isLoading = true;
        this.currentPage++;

        const lastRevision = this.ticketRevision;
        this.loadTicket(this.currentTab, this.currentPage, (list, err) => {
          if (!err) {
            if (this.ticketRevision === lastRevision) {
              for (let i in list) {
                this.appendTicket(list[i]);
              }
            }
          }
          this.isLoading = false;
        });
      }
    });

    let ticketNew = simplify(document.querySelector('.-sbd-ticket-list > .-sbd-ticket-new'));
    ticketNew.on('click', () => {
      const ticketNum = ('000' + (new Date().getTime() % 1000)).slice(-3);
      const tempTicketTitle = `Issue #${ticketNum}`;
      this.spinner.attachTo(this.ticketList);
      SendBirdDesk.Ticket.create(tempTicketTitle, user.nickname, (ticket, err) => {
        if (err) throw err;
        this.spinner.detach();
        this.startNewDialog(ticket);
      });
    });

    this.spinner = new Spinner();
    this.currentTab = '';
    this.currentPage = 0;
    this.payloadTicket = null;
    let selectTab = tab => {
      if (tab != this.currentTab) {
        for (let i = 0; i < tabs.length; i++) {
          let status = tabs[i].attr('data-status');
          if (status === tab) {
            tabBar.style.left = tabs[i].offsetLeft + 'px';
          }
        }

        if (tab === SendBirdDesk.Ticket.Status.OPEN) ticketNew.show();
        else ticketNew.hide();

        this.currentTab = tab;
        this.currentPage = 0;
        this.ticketRevision++;
        this.clearTicket();

        const lastRevision = this.ticketRevision;
        this.spinner.attachTo(this.ticketList);
        this.loadTicket(tab, this.currentPage, (list, err) => {
          this.spinner.detach();
          if (!err) {
            if (this.ticketRevision === lastRevision) {
              for (let i in list) {
                this.appendTicket(list[i]);
              }
              if (this.payloadTicket) {
                this.startNewDialog(this.payloadTicket);
                this.payloadTicket = null;
              }
            }
          }
        });
      }
    };

    /** SendBird Desk Widget action button
     */
    const guideBalloon = simplify(document.querySelector('.guide-balloon'));
    this.active = false;
    this.action = parseDom(`<div class='-sbd-action-button'></div>`);
    this.action.on('click', () => {
      this.active = !this.active;
      this.action.toggleClass('is-active');
      this.panel.toggleClass('fade-in');
      if (this.active) {
        selectTab(SendBirdDesk.Ticket.Status.OPEN);
      } else if (this.dialog) {
        setTimeout(() => {
          this.currentTab = '';
          this.dialog.close(true);
        }, 500);
      }

      /// guide balloon toggle
      if (this.active) {
        guideBalloon.hide();
      } else {
        guideBalloon.show();
      }
    });
    this.action.hide();
    this.element.appendChild(this.action);

    /** SendBird SDK and SendBird Desk SDK init
     *  NOTICE!
     *  Both this.sendbird.connect() and desk.authenticate() may have accessToken as a second param.
     *  The accessToken is not provided by SendBird SDK and Desk SDK.
     *  For more information, see https://docs.sendbird.com/javascript#authentication_3_connecting_with_userid_and_access_token.
     */
    // const accessToken = 'PUT-YOUR-OWN-ACCESS-TOKEN-HERE';
    this.sendbird = new SendBird({ appId: user.appId });
    this.sendbird.connect(
      user.userId,
      // accessToken,
      options.apiHost,
      options.wsHost,
      (res, err) => {
        if (err) throw err;
        this.sendbird.updateCurrentUserInfo(user.nickname, null, (res, err) => {
          if (err) throw err;
          if (DEBUG) SendBirdDesk.setDebugMode();
          SendBirdDesk.init(SendBird);
          if (options.deskApiHost) {
            SendBirdDesk.setApiHost(options.deskApiHost);
          }
          SendBirdDesk.authenticate(
            user.userId,
            // accessToken,
            (res, err) => {
              if (err) throw err;
              guideBalloon.fadeIn(300);
              this.action.show();

              /// connection event handler
              const connectionHandler = new this.sendbird.ConnectionHandler();
              connectionHandler.onReconnectStarted = () => {
                if (this.active) this.spinner.attachTo(this.ticketList);
              };
              connectionHandler.onReconnectSucceeded = () => {
                if (this.active) {
                  const lastTab = this.currentTab;
                  this.currentTab = '';
                  this.error.hide();

                  if (this.dialog && this.dialog.isOpened) {
                    this.dialog.ticket.channel.markAsRead();
                    this.dialog.ticket.refresh((res, err) => {
                      if (!err) {
                        this.dialog.ticket = res;
                        this.dialog.updateAgent(res.agent);
                      }
                    });
                    const lastRevision = this.dialog.messageRevision;
                    this.dialog.loadMessage(false, (res, err) => {
                      if (!err) {
                        if (this.dialog.messageRevision === lastRevision) {
                          const messages = res;
                          for (let i in messages) {
                            const message = messages[i];
                            if (MessageElement.isVisible(message)) {
                              this.dialog.prependMessage(message);
                            }
                          }
                          this.dialog.scrollToBottom();
                        }
                        this.spinner.detach();
                      }
                      selectTab(lastTab);
                    });
                  } else {
                    this.spinner.detach();
                    selectTab(lastTab);
                  }
                }
              };
              connectionHandler.onReconnectFailed = () => {
                if (this.active) {
                  this.spinner.detach();
                  this.error.show();
                }
              };
              this.sendbird.addConnectionHandler('widget', connectionHandler);

              /// channel/message event handler
              const channelHandler = new this.sendbird.ChannelHandler();
              channelHandler.onChannelChanged = channel => {
                SendBirdDesk.Ticket.getByChannelUrl(channel.url, (res, err) => {
                  if (err) throw err;
                  const ticket = res;
                  ticket.channel = channel;

                  /// update ticket widget
                  let ticketElementIndex = this.ticketElementList.findIndex(
                    ticketElement => ticketElement.ticket.id === ticket.id
                  );
                  let ticketElement = ticketElementIndex >= 0 ? this.ticketElementList[ticketElementIndex] : null;
                  if (ticketElement) {
                    ticketElement.ticket = ticket;
                    ticketElement.render();
                  }

                  /// update ticket widget list
                  const isInitial = ticket.status === SendBirdDesk.Ticket.Status.INITIALIZED;
                  const isClosed = ticket.status === SendBirdDesk.Ticket.Status.CLOSED;
                  const isNewest = ticketElementIndex === 0;
                  if (this.currentTab !== SendBirdDesk.Ticket.Status.CLOSED && !isNewest && !isClosed) {
                    /// detach current widget
                    if (ticketElement) {
                      this.ticketElementList.splice(ticketElementIndex, 1);
                      this.ticketList.removeChild(ticketElement.element);
                    } else if (!isInitial) {
                      ticketElement = new TicketElement(this, ticket);
                    }

                    /// attach the widget on the top
                    if (ticketElement) {
                      if (this.ticketElementList.length > 0) {
                        this.ticketList.insertBefore(ticketElement.element, this.ticketElementList[0].element);
                        this.ticketElementList.unshift(ticketElement);
                      } else {
                        this.ticketElementList.push(ticketElement);
                        this.ticketList.appendChild(ticketElement.element);
                      }
                    }
                  }
                });
              };
              channelHandler.onMessageReceived = (channel, message) => {
                console.log('message', message);
                if (!this.currentTab || this.currentTab === SendBirdDesk.Ticket.Status.OPEN) {
                  let data = null;
                  try {
                    data = message.data ? JSON.parse(message.data) : null;
                  } catch (e) {
                    throw e;
                  }

                  SendBirdDesk.Ticket.getByChannelUrl(channel.url, (res, err) => {
                    if (err) throw err;
                    const ticket = res;
                    if (data && data.ticket) ticket.status = data.ticket.status;

                    /** check if the message is system message
                     *  - isAssigned indicates that the ticket is assigned by an agent
                     *  - isTransferred indicates that the ticket is assigned to another agent
                     *  - isClosed indicates that the ticket is actually closed
                     */
                    message.isAssigned = data && data.type === SendBirdDesk.Message.DataType.TICKET_ASSIGN;
                    message.isTransferred = data && data.type === SendBirdDesk.Message.DataType.TICKET_TRANSFER;
                    message.isClosed = data && data.type === SendBirdDesk.Message.DataType.TICKET_CLOSE;

                    /// update ticket instance
                    if (message.isAssigned || message.isTransferred) {
                      ticket.agent = data.ticket.agent;
                    }

                    const ticketElementIndex = this.ticketElementList.findIndex(
                      ticketElement => ticketElement.ticket.id === ticket.id
                    );
                    const ticketElement = ticketElementIndex >= 0 ? this.ticketElementList[ticketElementIndex] : null;
                    if (ticketElement) {
                      ticketElement.ticket = ticket;
                      ticketElement.render();
                      if (message.isClosed) {
                        this.ticketElementList.splice(ticketElementIndex, 1);
                        this.ticketList.removeChild(ticketElement.element);
                      }
                    }

                    // show notification
                    if (!this.active) {
                      if (SendBirdDesk.isDeskChannel(channel)) {
                        if (MessageElement.isVisible(message)) {
                          const notification = new NotificationElement(ticket, message);
                          notification.render();
                          notification.onClick(ticket => {
                            notification.close();
                            this.payloadTicket = ticket;
                            this.action.click();
                          });
                          notification.open(this);
                        }
                      }
                    }
                  });
                  if (this.dialog && this.dialog.isOpened) {
                    if (this.dialog.ticket.channel.url === channel.url) {
                      if (MessageElement.isVisible(message)) {
                        this.dialog.appendMessage(message);
                      }
                      this.dialog.ticket.channel.markAsRead(() => {});
                    }
                  }
                }
              };
              channelHandler.onMessageUpdated = (channel, message) => {
                if (this.currentTab === SendBirdDesk.Ticket.Status.OPEN) {
                  SendBirdDesk.Ticket.getByChannelUrl(channel.url, (res, err) => {
                    if (err) throw err;
                    const ticket = res;
                    let data = null;
                    try {
                      data = message.data ? JSON.parse(message.data) : null;
                    } catch (e) {
                      throw e;
                    }
                    if (data && data.ticket) ticket.status = data.ticket.status;

                    let ticketElementIndex = this.ticketElementList.findIndex(
                      ticketElement => ticketElement.ticket.id === ticket.id
                    );
                    let ticketElement = ticketElementIndex >= 0 ? this.ticketElementList[ticketElementIndex] : null;

                    message.isClosureInquired =
                      data && data.type === SendBirdDesk.Message.DataType.TICKET_INQUIRE_CLOSURE;
                    if (message.isClosureInquired) {
                      const closureInquiry = data.body;
                      switch (closureInquiry.state) {
                        case SendBirdDesk.Message.ClosureState.CONFIRMED:
                          ticket.status = SendBirdDesk.Ticket.Status.CLOSED;
                          if (ticketElement) {
                            this.ticketElementList.splice(ticketElementIndex, 1);
                            this.ticketList.removeChild(ticketElement.element);
                          }
                          break;
                      }
                    }
                    if (this.dialog && this.dialog.isOpened) {
                      if (this.dialog.ticket.channel.url === channel.url) {
                        this.dialog.updateMessage(message);
                        if (ticket.status === SendBirdDesk.Ticket.Status.CLOSED) {
                          this.dialog.disableForm();
                        }
                      }
                    }
                  });
                }
              };
              this.sendbird.addChannelHandler('widget', channelHandler);
            }
          );
        });
      }
    );
  }
  loadTicket(status, offset, callback) {
    switch (status) {
      case SendBirdDesk.Ticket.Status.OPEN:
        SendBirdDesk.Ticket.getOpenedList(offset, (res, err) => {
          const tickets = res;
          this.noMoreTicket = tickets.length < SendBirdDesk.Ticket.defaultLimit;
          callback(res, err);
        });
        break;

      case SendBirdDesk.Ticket.Status.CLOSED:
        SendBirdDesk.Ticket.getClosedList(offset, (res, err) => {
          const tickets = res;
          this.noMoreTicket = tickets.length < SendBirdDesk.Ticket.defaultLimit;
          callback(res, err);
        });
        break;

      default:
        callback(null, []);
    }
  }
  appendTicket(ticket) {
    const widgetTicket = new TicketElement(this, ticket);
    this.ticketElementList.push(widgetTicket);
    this.ticketList.appendChild(widgetTicket.element);
  }
  clearTicket() {
    this.ticketElementList = [];
    this.ticketList.removeAll('-sbd-ticket-item');
  }
  signout() {
    this.sendbird.disconnect(() => {
      Broadcast.send('signout');
      if (this.panel.hasClass('fade-in')) {
        this.panel.toggleClass('fade-in');
        setTimeout(() => {
          this.element.removeChild(this.panel);
        }, 250);
      }
      this.element.removeChild(this.action);
    });
  }
  isBottom() {
    return this.ticketList.scrollHeight - this.ticketList.scrollTop === this.ticketList.clientHeight;
  }
  startNewDialog(ticket) {
    this.dialog = new Dialog(ticket);
    this.dialog.open(this);
  }
}
