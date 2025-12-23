# Tab 8: Profile

Tab: 'Profile' (appears as 'Login' if the user is not logged in)
Url: wallgame.io/profile

This page looks different depending on whether the user is logged in or not.

## Not logged in

The tab appears as "Login".

The page shows two main buttons: log in and sign up

It includes a bit of text: "Log in or sign up to choose a name, play rated games, and see your game history."

For the login and sign up flows, the user is redirected to an external auth service, so they are not part of this UI.

## Logged in

The tab appears as "Profile".

It shows the user display name and rating at the top, followed by a series of buttons grouped in two groups:

Group 1:

- Past Games: takes you to the Past Games tab but with the user's name already set as filter.
- Ranking: takes you to the Ranking tab but with the user's name already set as filter.
- Settings: takes you to the settings page.

Group 2:

- Log out
- Delete account

The delete account button shows a confirmation dialog: "Your email will be deleted from the DB and all games you played will appear as 'Deleted User' and you won't be able to play again with this account. Are you sure?"
