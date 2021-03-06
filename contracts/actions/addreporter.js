const initEnvironment = require(`eosiac`);
const { getAccountNames } = require(`./_helpers`);

const envName = process.env.EOSIAC_ENV || `dev`;

const { api, sendTransaction, env } = initEnvironment(envName, { verbose: true });

const {
  IBC_CONTRACT,
} = getAccountNames();


async function action() {
  try {
    const tx = await sendTransaction([
      {
        account: IBC_CONTRACT,
        name: `addreporter`,
        authorization: [
          {
            actor: IBC_CONTRACT,
            permission: `active`,
          },
        ],
        data: {
          reporter: `alohaeosprod`
        },
      },
    ]);

    console.log(tx)

    process.exit(0);
  } catch (error) {
    console.error(error.message);
    // ignore
    process.exit(1);
  }
}

action();
